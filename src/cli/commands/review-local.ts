import { isAbsolute, relative, resolve } from "node:path";

import { resolveProviderConfig } from "../../providers/index.js";
import { loadConfig, type LoadConfigOptions } from "../../config/loader.js";
import { parseDiff } from "../../review/parse-diff.js";
import { applyDiffLimits, describeSkipped } from "../../review/size-guards.js";
import { renderGuardedDiff } from "../../review/render-diff.js";
import { redactSecrets } from "../../review/redact.js";
import { filterSensitiveDiffFiles } from "../../review/sensitive-diff.js";
import { DEFAULT_IGNORE_GLOBS, filterIgnoredDiffFiles } from "../../review/ignore.js";
import { injectionNotes } from "../../review/injection.js";
import type { DiffFile, SkippedFile } from "../../review/diff-types.js";
import { summarizeLanguages } from "../../review/language.js";
import { DEFAULT_SPECIALISTS } from "../../review/specialists.js";
import { diffComplexity, planOrchestration, selectRiskTier } from "../../review/risk-tier.js";
import {
  gatherContext,
  formatGatheredContext,
  ContextRetrievalError,
  type RetrievalLimits
} from "../../context/retrieval.js";
import { buildGroundingSummary, gatherGrounding } from "../../grounding/index.js";
import { runReview, type ReviewInput, type ReviewResult } from "../../review/run-review.js";
import { emptyUsage, type TokenUsage } from "../../providers/index.js";
import type { FailbackEvent, FailbackOptions } from "../../providers/failback.js";
import { estimateCost, formatCostLine, resolveTokenBudget, totalTokens } from "../../cost/pricing.js";
import { appendUsageRecord, toUsageRecord } from "../../cost/usage-log.js";
import { createJsonlSink, type DebugSink } from "../../debug/trace.js";
import { SEVERITY_ORDER, type Finding, type Severity } from "../../review/findings.js";
import { formatLocalReport, formatLocalReportJson } from "../../review/format-terminal.js";
import {
  assertLocalHeadMatchesCheckout,
  resolveLocalDiff,
  resolveLocalWorkspace,
  LocalDiffError
} from "../../review/local-diff.js";
import {
  composeGuidelines,
  isForkPullRequestEvent,
  loadGuidelines,
  loadLearnedPatterns,
  parseMinSeverity,
  readOptionalFile,
  resolveConfigLoadOptions,
  resolveGuidelinesWorkspace,
  resolveOrgGuidelinesPath,
  resolveReviewOptions,
  resolveTrustWorkspace,
  resolveDebugLogPath,
  resolveUsageLogPath
} from "./review.js";

/**
 * `prowl-review review --base <ref> [--head <ref>]` — local pre-push mode (#35).
 *
 * Runs the exact same review engine (multi-pass specialists → verification →
 * judge) against a local git diff and prints findings to the terminal. No
 * GitHub token, no posting: it reads the diff from `git`, reuses the agentic
 * context (#4) + linter/SAST grounding (#16) over the local checkout, and
 * renders the result for a human (or `--json` for tooling). This gives a second
 * review layer before a PR ever exists.
 */

export interface LocalReviewCommandOptions {
  /** Base ref to diff against (defaults to `main`). */
  base?: string;
  /** Head ref; omitted reviews the working tree against the merge base. */
  head?: string;
  /** Severity floor for surfaced findings. */
  minSeverity?: string;
  /** `--no-context` → false. */
  context?: boolean;
  /** `--no-grounding` → false. */
  grounding?: boolean;
  /** `--no-verify` → false. */
  verify?: boolean;
  /** `--trust-workspace` → true, or `PROWL_TRUST_WORKSPACE=true`. */
  trustWorkspace?: boolean;
  /** `--config <path>` → string; `--no-config` → false. */
  config?: string | boolean;
  /** `--debug [path]` → true or a string path; absent → undefined (#49). */
  debug?: string | boolean;
  /** Emit machine-readable JSON instead of the human report. */
  json?: boolean;
  /** `--no-color` → false; otherwise honor TTY detection. */
  color?: boolean;
  /** Exit non-zero when a finding at/above this severity is found (pre-push gate). */
  failOn?: string;
}

/** Dependencies injected for testability (git + the heavy review stages). */
export interface LocalReviewDeps {
  resolveRoot?: typeof resolveLocalWorkspace;
  resolveHead?: typeof assertLocalHeadMatchesCheckout;
  resolveDiff?: typeof resolveLocalDiff;
  gatherContext?: typeof gatherContext;
  gatherGrounding?: typeof gatherGrounding;
  runReview?: typeof runReview;
  /** Sink for the rendered report (defaults to stdout). */
  out?: (text: string) => void;
  /** Sink for diagnostics/cost (defaults to stderr). */
  err?: (text: string) => void;
  /** Environment (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Clock injection for deterministic usage-log records. */
  now?: () => Date;
}

/** Result of a local review run, surfaced for the CLI action and tests. */
export interface LocalReviewResult {
  findings: Finding[];
  notes: string[];
  /** True when a finding met the `--fail-on` threshold. */
  failed: boolean;
}

/** Sum token usage from context retrieval and the review engine. */
function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const cacheWriteInputTokens = (a.cacheWriteInputTokens ?? 0) + (b.cacheWriteInputTokens ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    ...(cacheWriteInputTokens > 0 ? { cacheWriteInputTokens } : {})
  };
}

/** New-side changed line numbers per file path (for grounding's changed-line filter). */
function changedLinesByPath(files: DiffFile[]): Record<string, number[]> {
  const changed: Record<string, number[]> = {};
  for (const file of files) {
    const lines = new Set<number>();
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.type === "add" && line.newLine) {
          lines.add(line.newLine);
        }
      }
    }
    if (lines.size > 0) {
      changed[file.path] = [...lines].sort((a, b) => a - b);
    }
  }
  return changed;
}

/** A subset of {@link RetrievalLimits} fields, as carried by config + tier plans. */
type ContextLimitFields = { maxRounds?: number; maxFiles?: number; maxTokens?: number };

/** Merge explicit per-field context limits over the risk tier's defaults. */
function mergeContextLimits(
  explicit: ContextLimitFields | undefined,
  tier: ContextLimitFields | undefined
): RetrievalLimits | undefined {
  const merged: RetrievalLimits = {
    maxRounds: explicit?.maxRounds ?? tier?.maxRounds,
    maxFiles: explicit?.maxFiles ?? tier?.maxFiles,
    maxTokens: explicit?.maxTokens ?? tier?.maxTokens
  };
  return merged.maxRounds === undefined && merged.maxFiles === undefined && merged.maxTokens === undefined
    ? undefined
    : merged;
}

/** Redact untrusted linter finding text before it reaches prompts or reports. */
function redactGroundingFindings(findings: Finding[]): { findings: Finding[]; count: number } {
  let count = 0;
  const redacted = findings.map((finding) => {
    const title = redactSecrets(finding.title);
    const body = redactSecrets(finding.body);
    const suggestion = finding.suggestion ? redactSecrets(finding.suggestion) : undefined;
    count += title.count + body.count + (suggestion?.count ?? 0);
    return {
      ...finding,
      title: title.text,
      body: body.text,
      ...(suggestion ? { suggestion: suggestion.text } : {})
    };
  });
  return { findings: redacted, count };
}

/** Redact linter operational notes before rendering them locally. */
function redactGroundingNotes(notes: string[]): { notes: string[]; count: number } {
  let count = 0;
  const redacted = notes.map((note) => {
    const result = redactSecrets(note);
    count += result.count;
    return result.text;
  });
  return { notes: redacted, count };
}

/** Resolve trusted review guidance for local mode without trusting fork checkouts. */
function resolveLocalGuidance(root: string, env: NodeJS.ProcessEnv): {
  guidelines?: string;
  learnedPatterns?: string;
} {
  if (!isForkPullRequestEvent(env)) {
    return { guidelines: loadGuidelines(root), learnedPatterns: loadLearnedPatterns(root) };
  }

  const guidelinesRoot = resolveGuidelinesWorkspace(env);
  const repoGuidelines = guidelinesRoot ? loadGuidelines(guidelinesRoot) : undefined;
  const orgGuidelinesPath = resolveOrgGuidelinesPath(env);
  const orgGuidelines = orgGuidelinesPath ? readOptionalFile(orgGuidelinesPath) : undefined;
  return {
    guidelines: composeGuidelines(orgGuidelines, repoGuidelines),
    learnedPatterns: guidelinesRoot ? loadLearnedPatterns(guidelinesRoot) : undefined
  };
}

/** True when a path resolves within the reviewed checkout. */
function isWorkspacePath(path: string, root: string): boolean {
  const workspace = resolve(root);
  const candidate = resolve(path);
  const rel = relative(workspace, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Resolve explicit config paths as local review users expect: relative to the reviewed checkout. */
function resolveLocalConfigPath(configPath: string, root: string): string {
  return isAbsolute(configPath) ? resolve(configPath) : resolve(root, configPath);
}

/** Surface what the deterministic judge hid, so local output is not silently partial. */
function judgeNotes(reviewResult: ReviewResult): string[] {
  const notes: string[] = [];
  const { belowThreshold, belowConfidence, capped } = reviewResult.judge;
  if (belowThreshold > 0) {
    notes.push(`Hid ${belowThreshold} finding(s) below the severity floor.`);
  }
  if (belowConfidence > 0) {
    notes.push(`Hid ${belowConfidence} low-confidence finding(s) below the confidence floor.`);
  }
  if (capped > 0) {
    notes.push(`${capped} additional lower-ranked finding(s) not shown (findings cap reached).`);
  }
  return notes;
}

/**
 * Surface a coverage-affecting tier choice locally so tiny diffs do not look
 * like full review coverage when minimal tier trimmed passes or context.
 */
function riskTierNotes(
  selection: ReturnType<typeof selectRiskTier>,
  applied: {
    specialistKeys?: string[];
    contextLimited: boolean;
  }
): string[] {
  if (selection.tier !== "minimal") {
    return [];
  }

  const reductions: string[] = [];
  if (applied.specialistKeys) {
    reductions.push(`ran a reduced specialist set (${applied.specialistKeys.join(", ")})`);
  }
  if (applied.contextLimited) {
    reductions.push("limited cross-file context");
  }
  if (reductions.length === 0) {
    return [];
  }

  const appliedText =
    reductions.length === 1
      ? reductions[0]
      : `${reductions.slice(0, -1).join(", ")} and ${reductions[reductions.length - 1]}`;
  return [
    `Risk tier: minimal (${selection.changedLines} changed line(s), ${selection.fileCount} file(s)) — ` +
      `${appliedText} to scale cost with risk (#31). ` +
      "Set riskTiering.enabled: false to always run the full review."
  ];
}

/** Notes for cross-generation failbacks that occurred during a local review (#17). */
function failbackNotes(events: FailbackEvent[]): string[] {
  if (events.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const notes: string[] = [];
  for (const event of events) {
    const key = `${event.provider}:${event.from}->${event.to}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    notes.push(
      `Provider overload (#17): ${event.provider} fell back from \`${event.from}\` to \`${event.to}\` after retries; review ran on the older model.`
    );
  }
  return notes;
}

/** Resolve local-mode config without trusting auto-discovered fork checkout files. */
function resolveLocalConfigLoadOptions(
  options: LocalReviewCommandOptions,
  root: string,
  env: NodeJS.ProcessEnv
): LoadConfigOptions {
  const isFork = isForkPullRequestEvent(env);
  const configOptions = resolveConfigLoadOptions(options, root, env, isFork, root);
  const localConfigOptions = configOptions.configPath
    ? { ...configOptions, configPath: resolveLocalConfigPath(configOptions.configPath, root) }
    : configOptions;
  if (!isFork || localConfigOptions.disabled) {
    return localConfigOptions;
  }
  if (localConfigOptions.configPath) {
    return isWorkspacePath(localConfigOptions.configPath, root)
      ? { cwd: root, disabled: true }
      : localConfigOptions;
  }
  return { cwd: root, disabled: true };
}

/** Avoid making explicit-head reviews dirty just to record default local cost history. */
function resolveLocalUsageLogPath(root: string, env: NodeJS.ProcessEnv, head: string | undefined): string | null {
  if (head && !env.PROWL_USAGE_LOG?.trim()) {
    return null;
  }
  return resolveUsageLogPath(root, env);
}

/** Resolve whether to colorize: explicit `--no-color` wins; else honor TTY + NO_COLOR. */
export function resolveColor(cli: LocalReviewCommandOptions, env: NodeJS.ProcessEnv): boolean {
  if (cli.color === false) {
    return false;
  }
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") {
    return false;
  }
  return Boolean(process.stdout.isTTY);
}

/** True when any finding is at least as severe as the `--fail-on` threshold. */
export function meetsFailThreshold(findings: Finding[], threshold: Severity): boolean {
  const limit = SEVERITY_ORDER[threshold];
  return findings.some((finding) => SEVERITY_ORDER[finding.severity] <= limit);
}

/**
 * Resolve config + flags, run the review against a local git diff, and render the
 * result. Returns the findings so the CLI action can set the process exit code.
 */
export async function runLocalReview(
  options: LocalReviewCommandOptions,
  deps: LocalReviewDeps = {}
): Promise<LocalReviewResult> {
  const env = deps.env ?? process.env;
  const out = deps.out ?? ((text: string) => console.log(text));
  const err = deps.err ?? ((text: string) => console.error(text));
  const resolveRoot = deps.resolveRoot ?? resolveLocalWorkspace;
  const resolveHead = deps.resolveHead ?? assertLocalHeadMatchesCheckout;
  const resolveDiff = deps.resolveDiff ?? resolveLocalDiff;
  const gather = deps.gatherContext ?? gatherContext;
  const ground = deps.gatherGrounding ?? gatherGrounding;
  const review = deps.runReview ?? runReview;

  let root: string;
  try {
    root = await resolveRoot({ cwd: process.cwd(), env });
  } catch (error) {
    if (error instanceof LocalDiffError) {
      err(`prowl-review: ${error.message}`);
      return { findings: [], notes: [error.message], failed: true };
    }
    throw error;
  }

  const base = options.base?.trim() || "main";
  const head = options.head?.trim() || undefined;
  // Keep the ref/checkout match before repo config loading so a bad local
  // config cannot mask a checkout/ref mismatch. The clean check runs after
  // config loading, when config-only debug trace paths are known.
  try {
    await resolveHead({
      head,
      cwd: root,
      skipCleanCheck: true
    });
  } catch (error) {
    if (error instanceof LocalDiffError) {
      err(`prowl-review: ${error.message}`);
      return { findings: [], notes: [error.message], failed: true };
    }
    throw error;
  }

  const { config } = loadConfig(resolveLocalConfigLoadOptions(options, root, env));
  const failOn = parseMinSeverity(options.failOn);
  const debugLogPath = resolveDebugLogPath(options, config, root, env);
  try {
    await resolveHead({
      head,
      cwd: root,
      generatedOutputPaths: debugLogPath ? [debugLogPath] : [],
      skipRefCheck: true
    });
  } catch (error) {
    if (error instanceof LocalDiffError) {
      err(`prowl-review: ${error.message}`);
      return { findings: [], notes: [error.message], failed: true };
    }
    throw error;
  }

  // Reuse the GitHub command's flag→option resolution. Workspace execution is
  // still opt-in locally because repo config can run code via linters/plugins.
  const requestedTrustWorkspace = options.trustWorkspace ?? resolveTrustWorkspace(env);
  const resolved = resolveReviewOptions(
    {
      minSeverity: options.minSeverity,
      context: options.context,
      grounding: options.grounding,
      verify: options.verify,
      trustWorkspace: requestedTrustWorkspace,
      config: options.config
    },
    config,
    env
  );
  const trustWorkspace = resolved.trustWorkspace === true;

  let rawDiff: string;
  try {
    rawDiff = await resolveDiff({
      base,
      head,
      cwd: root,
      generatedOutputPaths: debugLogPath ? [debugLogPath] : []
    });
  } catch (error) {
    if (error instanceof LocalDiffError) {
      err(`prowl-review: ${error.message}`);
      return { findings: [], notes: [error.message], failed: true };
    }
    throw error;
  }

  const target = head ? `${base}...${head}` : `${base} → working tree`;
  const parsed = parseDiff(rawDiff);
  if (parsed.files.length === 0) {
    const message = `No changes to review (${target}).`;
    out(options.json ? formatLocalReportJson([], [message]) : formatLocalReport([], [message], { color: false }));
    return { findings: [], notes: [message], failed: false };
  }

  // Mirror the production pipeline's diff prep: drop sensitive files, then the
  // ignore list, then apply size guards — reporting (never silently dropping)
  // everything skipped (#5).
  const sensitive = filterSensitiveDiffFiles(parsed.files);
  const ignored = filterIgnoredDiffFiles(sensitive.files, resolved.ignore ?? DEFAULT_IGNORE_GLOBS);
  const guarded = applyDiffLimits({ files: ignored.files }, resolved.diffLimits);
  const reviewFiles = guarded.files;
  const skipped: SkippedFile[] = [...sensitive.skipped, ...ignored.skipped, ...guarded.skipped];
  const reviewPathSet = new Set(reviewFiles.map((file) => file.path));
  const sensitiveSkippedPaths = new Set(skipped.filter((file) => file.reason === "sensitive").map((file) => file.path));
  const secretScanFiles = parsed.files.filter((file) => sensitiveSkippedPaths.has(file.path) && !reviewPathSet.has(file.path));
  const groundingLineFiles = [...reviewFiles, ...secretScanFiles];
  const secretScanPathSet = new Set(secretScanFiles.map((file) => file.path));
  const secretScanWholeFilePaths = secretScanFiles
    .filter((file) => file.status === "renamed" || file.status === "copied")
    .map((file) => file.path);
  const semgrepWholeFilePaths = reviewFiles.filter((file) => file.status === "copied").map((file) => file.path);

  const notes: string[] = [];
  const skippedNote = describeSkipped(skipped);
  if (skippedNote) {
    notes.push(`Skipped files — ${skippedNote}`);
  }
  notes.push(...injectionNotes(reviewFiles));

  let grounding: ReviewInput["grounding"];
  let directGroundingFindings: Finding[] = [];
  let groundingTrace = { findings: 0, notes: 0 };
  if (!resolved.skipGrounding && groundingLineFiles.length > 0) {
    try {
      const result = await ground({
        root,
        changedPaths: reviewFiles.map((file) => file.path),
        secretScanPaths: secretScanFiles.map((file) => file.path),
        secretScanWholeFilePaths,
        semgrepWholeFilePaths,
        changedLines: changedLinesByPath(groundingLineFiles),
        trustWorkspace,
        semgrep: resolved.semgrep
      });
      const redactedNotes = redactGroundingNotes(result.notes);
      for (const note of redactedNotes.notes) {
        notes.push(`Linter grounding: ${note}`);
      }
      const redacted = redactGroundingFindings(result.findings);
      const groundingFindings = redacted.findings;
      groundingTrace = { findings: groundingFindings.length, notes: redactedNotes.notes.length };
      directGroundingFindings = groundingFindings.filter((finding) => secretScanPathSet.has(finding.file));
      const promptGroundingFindings = groundingFindings.filter((finding) => !secretScanPathSet.has(finding.file));
      const redactionCount = redacted.count + redactedNotes.count;
      if (redactionCount > 0) {
        notes.push(`Redacted ${redactionCount} secret(s) from linter grounding output.`);
      }
      if (directGroundingFindings.length > 0 && reviewFiles.length > 0) {
        notes.push(
          `Linter grounding: kept ${directGroundingFindings.length} sensitive-file secret finding(s) outside provider verification.`
        );
      }
      if (promptGroundingFindings.length > 0) {
        grounding = { findings: promptGroundingFindings, summary: buildGroundingSummary(promptGroundingFindings) };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const redacted = redactSecrets(message);
      if (redacted.count > 0) {
        notes.push(`Redacted ${redacted.count} secret(s) from linter grounding output.`);
      }
      notes.push(`Linter grounding failed; continuing without it: ${redacted.text}`);
      groundingTrace = { findings: 0, notes: 1 };
    }
  }

  if (reviewFiles.length === 0) {
    const message = `No reviewable files remained after filters (${target}).`;
    notes.push(message);
    out(
      options.json
        ? formatLocalReportJson(directGroundingFindings, notes)
        : formatLocalReport(directGroundingFindings, notes, { color: false })
    );
    const failed = failOn ? meetsFailThreshold(directGroundingFindings, failOn) : false;
    return { findings: directGroundingFindings, notes, failed };
  }

  // Risk-tiered orchestration (#31): scale passes + context to diff complexity.
  const tierSelection = selectRiskTier(diffComplexity(reviewFiles), resolved.riskTiering);
  const tierPlan = planOrchestration(tierSelection.tier);
  const effectiveSpecialists =
    resolved.specialists ??
    (tierPlan.builtinSpecialistKeys
      ? DEFAULT_SPECIALISTS.filter((s) => tierPlan.builtinSpecialistKeys!.includes(s.key))
      : undefined);
  const effectiveContextLimits = mergeContextLimits(resolved.contextLimits, tierPlan.contextLimits);
  const tierSpecialistKeys = resolved.specialists === undefined ? tierPlan.builtinSpecialistKeys : undefined;
  const tierLimitedContext =
    !resolved.skipContext &&
    ((resolved.contextLimits?.maxRounds === undefined && tierPlan.contextLimits?.maxRounds !== undefined) ||
      (resolved.contextLimits?.maxFiles === undefined && tierPlan.contextLimits?.maxFiles !== undefined));
  notes.push(...riskTierNotes(tierSelection, { specialistKeys: tierSpecialistKeys, contextLimited: tierLimitedContext }));

  const providerConfig = resolveProviderConfig(env, { provider: config.provider, model: config.model });

  // Debug/verbose tracing (#49): local mode has its own orchestration path, so
  // it creates and feeds the sink directly while keeping stdout clean for --json.
  let debug: DebugSink | undefined;
  if (debugLogPath) {
    debug = createJsonlSink(debugLogPath, { workspace: root });
    err(`prowl-review: writing debug trace to ${relative(root, debugLogPath) || debugLogPath} (#49).`);
    debug({
      type: "run-start",
      pr: `local:${head ? `${base}...${head}` : `${base}...working-tree`}`,
      provider: providerConfig.provider,
      model: providerConfig.model,
      dryRun: false,
      incremental: false
    });
    debug({ type: "diff", reviewedFiles: reviewFiles.length, skippedFiles: skipped.length });
    debug({ type: "grounding", findings: groundingTrace.findings, notes: groundingTrace.notes });
  }

  // Per-PR budget (#18): cap context retrieval + verification token spend.
  const budget = resolveTokenBudget(config.budget, providerConfig.provider, providerConfig.model, config.pricing ?? {});
  for (const note of budget.notes) {
    err(`prowl-review: ${note}`);
  }
  const budgetTokens = budget.tokens ?? undefined;

  const renderedDiff = renderGuardedDiff(reviewFiles);
  const redactedDiff = redactSecrets(renderedDiff);
  if (redactedDiff.count > 0) {
    notes.push(`Redacted ${redactedDiff.count} secret(s) from the diff.`);
  }

  const { guidelines, learnedPatterns } = resolveLocalGuidance(root, env);
  const failbackEvents: FailbackEvent[] = [];
  const failback: FailbackOptions | undefined = resolved.failback
    ? { onFailback: (event) => failbackEvents.push(event) }
    : undefined;

  let usage = emptyUsage();
  let context: string | undefined;
  if (!resolved.skipContext && reviewFiles.length > 0) {
    try {
      const contextMaxTokens =
        budgetTokens === undefined
          ? effectiveContextLimits?.maxTokens
          : effectiveContextLimits?.maxTokens === undefined
            ? budgetTokens
            : Math.min(budgetTokens, effectiveContextLimits.maxTokens);
      const gathered = await gather({
        toolkit: { root },
        changedPaths: reviewFiles.map((file) => file.path),
        config: providerConfig,
        limits: { ...effectiveContextLimits, maxTokens: contextMaxTokens }
      });
      usage = addUsage(usage, gathered.usage);
      for (const note of gathered.notes) {
        notes.push(`Context retrieval: ${note}`);
      }
      const joined = formatGatheredContext(gathered);
      if (joined !== undefined) {
        context = redactSecrets(joined).text;
      }
      debug?.({
        type: "context",
        files: gathered.files.map((file) => ({ path: file.path, truncated: file.truncated })),
        rounds: gathered.rounds,
        reachedLimit: gathered.reachedLimit
      });
    } catch (error) {
      if (error instanceof ContextRetrievalError) {
        usage = addUsage(usage, error.usage);
      }
      const message = error instanceof Error ? error.message : String(error);
      notes.push(`Context retrieval failed; continuing without extra context: ${message}`);
    }
  }

  const reviewBudgetTokens =
    budgetTokens === undefined ? undefined : Math.max(0, budgetTokens - totalTokens(usage));
  const reviewResult = await review(
    {
      diff: redactedDiff.text,
      context: reviewBudgetTokens === 0 ? undefined : context,
      guidelines,
      learnedPatterns,
      languages: summarizeLanguages(reviewFiles.map((file) => file.path)).map((language) => language.label),
      grounding,
      specialists: effectiveSpecialists
    },
    {
      config: providerConfig,
      minSeverity: resolved.minSeverity,
      minConfidence: resolved.minConfidence,
      maxFindings: resolved.maxFindings,
      verify: resolved.verify,
      verifyConfidence: resolved.verifyConfidence,
      maxTokens: reviewBudgetTokens,
      ...(failback ? { failback } : {}),
      ...(debug ? { debug } : {})
    }
  );
  usage = addUsage(usage, reviewResult.usage);

  notes.push(...failbackNotes(failbackEvents));

  // Degraded passes / verification are operational notes, not silent drops (#56).
  for (const pass of reviewResult.passes) {
    if (!pass.ok) {
      notes.push(`Specialist "${pass.specialist}" degraded: ${pass.error ?? "unparseable output"}.`);
    }
  }
  if (reviewResult.verification.skippedForBudget) {
    notes.push("Skipped false-positive verification to stay within the token budget (#18); raise the budget for the extra precision pass.");
  }
  if (!reviewResult.verification.ok) {
    notes.push(`Verification degraded: ${reviewResult.verification.error ?? "unknown error"}.`);
  }
  notes.push(...judgeNotes(reviewResult));

  const findings = [...directGroundingFindings, ...reviewResult.findings];
  out(
    options.json
      ? formatLocalReportJson(findings, notes)
      : formatLocalReport(findings, notes, { color: resolveColor(options, env) })
  );

  // Cost transparency (#36) goes to stderr so `--json` stdout stays clean.
  const cost = estimateCost(usage, providerConfig.provider, providerConfig.model, config.pricing ?? {});
  const tierSuffix = ` · risk tier: ${tierSelection.tier}`;
  err(`prowl-review cost: ${formatCostLine(cost)}${tierSuffix}`);
  debug?.({
    type: "usage",
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteInputTokens: usage.cacheWriteInputTokens ?? 0
  });
  debug?.({
    type: "cost",
    estimates: [
      {
        provider: cost.provider,
        model: cost.model,
        usd: cost.usd,
        totalTokens: cost.totalTokens
      }
    ]
  });
  debug?.({ type: "run-end", findings: findings.length, posted: false });

  const usageLogPath = resolveLocalUsageLogPath(root, env, head);
  if (usageLogPath) {
    try {
      appendUsageRecord(
        usageLogPath,
        toUsageRecord(cost, { ts: (deps.now?.() ?? new Date()).toISOString() }),
        { workspace: root }
      );
    } catch {
      // non-fatal: usage log unavailable
    }
  }

  const failed = failOn ? meetsFailThreshold(findings, failOn) : false;
  return { findings, notes, failed };
}
