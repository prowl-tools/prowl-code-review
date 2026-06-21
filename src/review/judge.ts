import {
  type Finding,
  type ProviderPerspective,
  type Severity,
  SEVERITY_ORDER,
  findingKey
} from "./findings.js";

/**
 * Deterministic judge pass (backlog #6) + high-signal defaults (backlog #55):
 * consolidate the specialists' raw findings into one clean, ranked list: drop
 * low-severity/low-confidence noise, dedup identical issues, rank, and cap the
 * volume — so the default review is useful, not noisy.
 *
 * The skeptical "is this actually a bug?" LLM verification is a separate pass
 * (backlog #8); this layer is pure and fully testable.
 */

/** Default floor: hide `trivial`/`info` unless the caller opts in. */
export const DEFAULT_MIN_SEVERITY: Severity = "minor";
/** Default confidence floor; non-critical findings below this are dropped. */
export const DEFAULT_MIN_CONFIDENCE = 0.5;
/** Default cap on the number of findings surfaced. */
export const DEFAULT_MAX_FINDINGS = 25;

/** Per-provider confidence bump for a cross-provider agreement (capped at 1). */
const CONSENSUS_CONFIDENCE_STEP = 0.15;

/** Pick the stronger of two duplicate findings (higher severity, then confidence). */
function preferred(a: Finding, b: Finding): Finding {
  const severityDelta = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (severityDelta !== 0) {
    return severityDelta < 0 ? a : b;
  }
  return b.confidence > a.confidence ? b : a;
}

/** Union two findings' provider provenance lists (#53), or undefined when neither has any. */
function mergeSources(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (!a && !b) {
    return undefined;
  }
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

/**
 * Merge two findings' per-provider perspectives (#53), one entry per provider
 * (keeping that provider's strongest take), so a consolidated finding carries
 * every model's distinct view. Undefined when neither side has perspectives.
 */
function mergePerspectives(
  a: ProviderPerspective[] | undefined,
  b: ProviderPerspective[] | undefined
): ProviderPerspective[] | undefined {
  const all = [...(a ?? []), ...(b ?? [])];
  if (all.length === 0) {
    return undefined;
  }
  const byProvider = new Map<string, ProviderPerspective>();
  for (const perspective of all) {
    const existing = byProvider.get(perspective.provider);
    const stronger =
      !existing ||
      SEVERITY_ORDER[perspective.severity] < SEVERITY_ORDER[existing.severity] ||
      (perspective.severity === existing.severity && perspective.confidence > existing.confidence);
    if (stronger) {
      byProvider.set(perspective.provider, perspective);
    }
  }
  return [...byProvider.values()];
}

/**
 * Boost a finding's confidence when multiple providers independently raised it
 * (#53): cross-provider agreement is itself a verification signal (#8). A single
 * provider (or none) leaves confidence unchanged.
 */
export function consensusConfidence(base: number, providerCount: number): number {
  if (providerCount <= 1) {
    return base;
  }
  return Math.min(1, base + CONSENSUS_CONFIDENCE_STEP * (providerCount - 1));
}

function lineKey(finding: Finding): string | null {
  return finding.line ? `${finding.file}|${finding.line}` : null;
}

function isLintFinding(finding: Finding): boolean {
  return finding.category.toLowerCase() === "lint";
}

function normalizeDedupeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

interface LintDedupeEntry {
  key: string;
  matchers: string[];
}

function lintMatcherTerms(finding: Finding): string[] {
  const title = normalizeDedupeText(finding.title);
  const body = normalizeDedupeText(finding.body.replace(/\s*\([^)]*\)\s*$/, ""));
  return [title && title !== "eslint" ? title : "", body].filter((term) => term.length >= 4);
}

function lintDedupeKey(loc: string, finding: Finding): string {
  return `${loc}|lint|${lintMatcherTerms(finding)[0] ?? "eslint"}`;
}

function findingText(finding: Finding): string {
  return normalizeDedupeText(`${finding.title} ${finding.body}`);
}

function matchingLintKey(finding: Finding, entries: LintDedupeEntry[] | undefined): string | null {
  if (!entries) {
    return null;
  }
  const text = findingText(finding);
  for (const { key, matchers } of entries) {
    if (matchers.some((matcher) => text.includes(matcher))) {
      return key;
    }
  }
  return null;
}

function dedupeBucket(finding: Finding, lintEntries: Map<string, LintDedupeEntry[]>): string {
  const loc = lineKey(finding);
  if (loc && isLintFinding(finding)) {
    return lintDedupeKey(loc, finding);
  }
  if (loc) {
    const key = matchingLintKey(finding, lintEntries.get(loc));
    if (key) {
      return key;
    }
  }
  return findingKey(finding);
}

/**
 * Collapse duplicate findings, keeping the strongest.
 *
 * Normal model findings dedupe by file + line + category. Linter grounding is
 * special: if a specialist re-reports the same linter-backed line with another
 * category, collapse those together too.
 */
export function dedupeFindings(findings: Finding[], options: { mergeProvenance?: boolean } = {}): Finding[] {
  const lintEntries = new Map<string, LintDedupeEntry[]>();
  // Build lint matchers first so specialist findings dedupe regardless of order.
  for (const finding of findings) {
    if (!isLintFinding(finding)) {
      continue;
    }
    const loc = lineKey(finding);
    if (!loc) {
      continue;
    }
    const entries = lintEntries.get(loc) ?? [];
    entries.push({ key: lintDedupeKey(loc, finding), matchers: lintMatcherTerms(finding) });
    lintEntries.set(loc, entries);
  }
  const byKey = new Map<string, Finding>();
  const baseConfidenceByKey = new Map<string, number>();
  for (const finding of findings) {
    const key = dedupeBucket(finding, lintEntries);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, finding);
      baseConfidenceByKey.set(key, finding.confidence);
      continue;
    }
    // Cross-provider consolidation (#53): keep the strongest representative but
    // union the provenance and boost confidence by how many providers agreed.
    if (options.mergeProvenance) {
      const existingBaseConfidence = baseConfidenceByKey.get(key) ?? existing.confidence;
      const existingForPreference = { ...existing, confidence: existingBaseConfidence };
      const winner = preferred(existingForPreference, finding);
      const winnerBaseConfidence = winner === finding ? finding.confidence : existingBaseConfidence;
      const sources = mergeSources(existing.sources, finding.sources);
      const perspectives = mergePerspectives(existing.perspectives, finding.perspectives);
      baseConfidenceByKey.set(key, winnerBaseConfidence);
      byKey.set(key, {
        ...winner,
        confidence: sources ? consensusConfidence(winnerBaseConfidence, sources.length) : winnerBaseConfidence,
        ...(sources ? { sources } : {}),
        ...(perspectives ? { perspectives } : {})
      });
    } else {
      const winner = preferred(existing, finding);
      baseConfidenceByKey.set(key, winner.confidence);
      byKey.set(key, winner);
    }
  }
  return [...byKey.values()];
}

/** Sort by severity (most severe first), breaking ties by confidence then file. */
export function rankFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const severityDelta = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (severityDelta !== 0) {
      return severityDelta;
    }
    if (b.confidence !== a.confidence) {
      return b.confidence - a.confidence;
    }
    return findingKey(a).localeCompare(findingKey(b));
  });
}

/** Drop findings less severe than `minSeverity`. */
export function filterBySeverity(findings: Finding[], minSeverity: Severity): Finding[] {
  const floor = SEVERITY_ORDER[minSeverity];
  return findings.filter((finding) => SEVERITY_ORDER[finding.severity] <= floor);
}

/** Drop non-critical findings below `minConfidence` (criticals always kept). */
export function filterByConfidence(findings: Finding[], minConfidence: number): Finding[] {
  return findings.filter(
    (finding) => finding.severity === "critical" || finding.confidence >= minConfidence
  );
}

export interface JudgeOptions {
  /** Drop findings below this severity. Default {@link DEFAULT_MIN_SEVERITY}. */
  minSeverity?: Severity;
  /** Drop non-critical findings below this confidence. Default {@link DEFAULT_MIN_CONFIDENCE}. */
  minConfidence?: number;
  /** Cap the number of findings surfaced. Default {@link DEFAULT_MAX_FINDINGS}. */
  maxFindings?: number;
}

export interface JudgeResult {
  /** Consolidated, ranked, capped findings. */
  findings: Finding[];
  /** How many duplicates were collapsed. */
  duplicatesRemoved: number;
  /** How many findings were dropped by the severity threshold. */
  belowThreshold: number;
  /** How many findings were dropped by the confidence floor. */
  belowConfidence: number;
  /** How many findings were dropped by the volume cap. */
  capped: number;
}

function normalizeMaxFindings(value: number | undefined, available: number): number {
  const requested = value ?? DEFAULT_MAX_FINDINGS;
  if (Number.isNaN(requested)) {
    return Math.min(available, DEFAULT_MAX_FINDINGS);
  }
  if (requested === Infinity) {
    return available;
  }
  if (requested === -Infinity) {
    return 0;
  }
  return Math.min(available, Math.max(0, Math.floor(requested)));
}

/** Run the full deterministic judge: severity → confidence → dedupe → rank → cap. */
export function judgeFindings(findings: Finding[], options: JudgeOptions = {}): JudgeResult {
  const minSeverity = options.minSeverity ?? DEFAULT_MIN_SEVERITY;
  const afterSeverity = filterBySeverity(findings, minSeverity);
  const belowThreshold = findings.length - afterSeverity.length;

  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const afterConfidence = filterByConfidence(afterSeverity, minConfidence);
  const belowConfidence = afterSeverity.length - afterConfidence.length;

  const deduped = dedupeFindings(afterConfidence);
  const duplicatesRemoved = afterConfidence.length - deduped.length;

  const ranked = rankFindings(deduped);
  const maxFindings = normalizeMaxFindings(options.maxFindings, ranked.length);
  const capped = Math.max(0, ranked.length - maxFindings);

  return {
    findings: ranked.slice(0, maxFindings),
    duplicatesRemoved,
    belowThreshold,
    belowConfidence,
    capped
  };
}

/**
 * Cross-provider judge for the ensemble (#53). Pools findings already tagged with
 * their source provider and consolidates them. Unlike {@link judgeFindings},
 * dedupe-with-provenance runs **first** so a finding several providers agree on
 * gets its consensus confidence boost *before* the confidence floor — agreement
 * can rescue a finding each provider reported just under the threshold.
 */
export function judgeEnsembleFindings(findings: Finding[], options: JudgeOptions = {}): JudgeResult {
  const deduped = dedupeFindings(findings, { mergeProvenance: true });
  const duplicatesRemoved = findings.length - deduped.length;

  const minSeverity = options.minSeverity ?? DEFAULT_MIN_SEVERITY;
  const afterSeverity = filterBySeverity(deduped, minSeverity);
  const belowThreshold = deduped.length - afterSeverity.length;

  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const afterConfidence = filterByConfidence(afterSeverity, minConfidence);
  const belowConfidence = afterSeverity.length - afterConfidence.length;

  const ranked = rankFindings(afterConfidence);
  const maxFindings = normalizeMaxFindings(options.maxFindings, ranked.length);
  const capped = Math.max(0, ranked.length - maxFindings);

  return {
    findings: ranked.slice(0, maxFindings),
    duplicatesRemoved,
    belowThreshold,
    belowConfidence,
    capped
  };
}
