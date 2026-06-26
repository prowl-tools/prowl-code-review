import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { z } from "zod";
import type { Finding, Severity } from "../review/findings.js";
import { detectLanguage, isJavaScriptFamily, type LanguageId } from "../review/language.js";
// `relative`/`isAbsolute` are used for normalizing ESLint's absolute paths back
// to repo-relative; changed-path safety is checked structurally below.

/**
 * Linter / SAST grounding (backlog #16) — the third differentiator.
 *
 * Run the repository's own deterministic linters on the changed files, normalize
 * their output to {@link Finding}s, and feed them into the review as grounding:
 * the specialists see "here's what the linter already found" and reconcile rather
 * than re-discover (or hallucinate). Catches mechanical issues for free and
 * raises precision.
 *
 * ESLint is the first runner (JS/TS — the suite's primary stack); the shape here
 * generalizes to Gitleaks/Semgrep and, with #5's language detection, to more
 * languages. Everything is workspace-confined, bounded, and degrades gracefully:
 * if a linter isn't installed we skip it with a note rather than failing.
 */

/** Result of running an external command. */
export interface ExecResult {
  stdout: string;
  stderr: string;
  /** Exit code; null when the process was killed (e.g. timeout). */
  code: number | null;
}

export interface ExecOptions {
  /** Extra environment overrides for this invocation. */
  env?: NodeJS.ProcessEnv;
}

/** Injectable command runner (defaults to a confined `execFile`). */
export type Exec = (command: string, args: string[], cwd: string, options?: ExecOptions) => Promise<ExecResult>;

export interface GroundingLimits {
  /** Max changed files passed to a linter. Default {@link DEFAULT_MAX_FILES}. */
  maxFiles?: number;
  /** Max findings kept per linter (rest reported as truncated). Default {@link DEFAULT_MAX_FINDINGS}. */
  maxFindings?: number;
  /** Per-linter timeout in milliseconds. Default {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

export const DEFAULT_MAX_FILES = 100;
export const DEFAULT_MAX_FINDINGS = 50;
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Semgrep SAST grounding policy (#16b). */
export interface SemgrepOptions {
  /**
   * Run Semgrep over changed source files and feed its findings into the review.
   * Default on; skips gracefully when semgrep isn't installed. Set false to disable.
   */
  enabled?: boolean;
  /**
   * Ruleset to run. Default {@link DEFAULT_SEMGREP_CONFIG} (a curated registry
   * pack). Registry refs (`p/...`, `r/...`, `auto`) run ungated; a repo-relative
   * path (e.g. `.semgrep.yml`) or remote URL is honored ONLY when the workspace
   * is trusted, since a PR could ship a malicious/noisy ruleset.
   */
  config?: string;
}

/** Dependency-CVE / license scanning policy (#34). */
export interface DependencyScanOptions {
  /**
   * Scan changed dependency lockfiles for known vulnerabilities with osv-scanner.
   * Default on; skips gracefully when osv-scanner isn't installed. Set false to disable.
   */
  enabled?: boolean;
  /**
   * License policy. When `allow` is set, a dependency whose license is outside the
   * SPDX allowlist is flagged. Omitted → no license checking (vuln scan only).
   */
  licenses?: { allow?: string[] };
}

export interface GatherGroundingParams {
  /** Repo checkout root the linters run inside. */
  root: string;
  /** Repo-relative changed file paths (new side). */
  changedPaths: string[];
  /**
   * Extra repo-relative changed paths that only secret scanners may inspect.
   * Used for sensitive files that must stay out of reviewer prompts/context.
   */
  secretScanPaths?: string[];
  /**
   * Secret scan paths whose path exposure is itself changed. Findings from these
   * paths bypass changed-line filtering when no added-line evidence exists.
   */
  secretScanWholeFilePaths?: string[];
  /**
   * New-side changed lines by repo-relative file path. When provided, linter
   * messages outside these lines are dropped so pre-existing lint failures do
   * not become PR findings.
   */
  changedLines?: Record<string, readonly number[]>;
  /**
   * Whether it is safe to execute repository-defined linter code/config in
   * `root`. Keep false for untrusted PR checkouts.
   */
  trustWorkspace?: boolean;
  /** Injectable command runner (defaults to a confined execFile). */
  exec?: Exec;
  limits?: GroundingLimits;
  /** Semgrep SAST grounding policy (#16b). Omitted → enabled with the default ruleset. */
  semgrep?: SemgrepOptions;
  /** Dependency-CVE / license scanning policy (#34). Omitted → enabled with vuln scan only. */
  dependencyScan?: DependencyScanOptions;
  /**
   * Changed dependency manifest/lockfile paths for the dependency scan (#34),
   * sourced from the full diff so a lockfile excluded from line-review by the
   * ignore list (#19) is still scanned. Falls back to {@link changedPaths}.
   */
  dependencyPaths?: string[];
}

export interface GroundingResult {
  /** Deterministic findings normalized from linter output. */
  findings: Finding[];
  /** Operational notes (skips, truncation, errors) — surfaced, never silent. */
  notes: string[];
}

/** Default command runner: `execFile` confined to `cwd`, bounded output + time. */
function defaultExec(timeoutMs: number): Exec {
  return (command, args, cwd, options) =>
    new Promise<ExecResult>((resolve) => {
      execFile(
        command,
        args,
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
          env: options?.env ? { ...process.env, ...options.env } : process.env
        },
        (error, stdout, stderr) => {
          let code: number | null = 0;
          if (error) {
            const errorCode = (error as { code?: unknown }).code;
            code = typeof errorCode === "number" ? errorCode : errorCode === "ENOENT" ? 127 : 1;
          }
          resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
        }
      );
    });
}

/**
 * Keep only repo-relative paths that stay inside the workspace. Changed paths
 * are already repo-relative, so reject absolutes and any `..` traversal segment
 * (defense-in-depth against odd diff paths) without resolving against cwd.
 */
function safeRelativePaths(paths: string[]): string[] {
  const safe: string[] = [];
  for (const path of paths) {
    if (isAbsolute(path)) {
      continue;
    }
    const normalized = path.replace(/^\.\//, "");
    if (normalized.split(/[\\/]/).includes("..")) {
      continue; // escapes the workspace
    }
    safe.push(normalized);
  }
  return safe;
}

function normalizeRelativePath(path: string): string {
  return path.replace(/^\.\//, "").replace(/\\/g, "/");
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const results: R[] = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await mapper(items[index]);
      }
    })
  );
  return results;
}

const ESLINT_DIAGNOSTIC_LIMIT = 500;

interface EslintMessage {
  ruleId: string | null;
  severity: 1 | 2;
  message: string;
  line?: number;
  endLine?: number;
}

interface EslintFileResult {
  filePath: string;
  messages: EslintMessage[];
}

/** Map an ESLint message to a low-severity, high-confidence grounding finding. */
function eslintToFinding(root: string, fileResult: EslintFileResult, message: EslintMessage): Finding {
  // ESLint reports absolute paths; normalize back to repo-relative.
  const absolute = fileResult.filePath;
  const file = isAbsolute(absolute) ? relative(root, absolute) : absolute;
  // error → minor, warning → info: linters are mostly mechanical/polish, so they
  // ground the LLM without drowning out real findings (#55 floors do the rest).
  const severity: Severity = message.severity === 2 ? "minor" : "info";
  return {
    file: file.replace(/[\\/]/g, "/"),
    ...(message.line ? { line: message.line } : {}),
    ...(message.endLine && message.line && message.endLine > message.line ? { endLine: message.endLine } : {}),
    severity,
    category: "lint",
    title: message.ruleId ?? "eslint",
    body: message.ruleId ? `${message.message} (${message.ruleId})` : message.message,
    confidence: 0.9
  };
}

/** Normalize changed-line maps to repo-relative slash paths for lookup. */
function changedLineLookup(changedLines: GatherGroundingParams["changedLines"]): Map<string, Set<number>> | undefined {
  if (!changedLines) {
    return undefined;
  }
  const lookup = new Map<string, Set<number>>();
  for (const [file, lines] of Object.entries(changedLines)) {
    const normalized = normalizeRelativePath(file);
    lookup.set(normalized, new Set(lines.filter((line) => Number.isInteger(line) && line > 0)));
  }
  return lookup;
}

/** Keep only findings whose line range intersects the new-side changed lines. */
function filterToChangedLines(
  findings: Finding[],
  changedLines: Map<string, Set<number>> | undefined,
  wholeFilePaths = new Set<string>()
): Finding[] {
  if (!changedLines) {
    return findings;
  }
  return findings.filter((finding) => {
    const file = normalizeRelativePath(finding.file);
    if (wholeFilePaths.has(file)) {
      return true;
    }
    if (!finding.line) {
      return false;
    }
    const lines = changedLines.get(file);
    if (!lines || lines.size === 0) {
      return false;
    }
    const start = finding.line;
    const end = finding.endLine && finding.endLine > start ? finding.endLine : start;
    for (let line = start; line <= end; line += 1) {
      if (lines.has(line)) {
        return true;
      }
    }
    return false;
  });
}

/** True when the failure indicates the ESLint executable is unavailable. */
function isEslintUnavailable(result: ExecResult, eslintScriptPath: string): boolean {
  if (result.code === 127) {
    return true;
  }
  const text = `${result.stderr}\n${result.stdout}`;
  if (/Cannot find module/i.test(text) && text.includes(eslintScriptPath)) {
    return true;
  }
  return /(?:command not found|not recognized as an internal or external command|could not determine executable to run|spawn .* ENOENT)/i.test(text);
}

/** Keep non-JSON/non-zero ESLint failures actionable without flooding comments. */
function eslintFailureNote(result: ExecResult): string {
  const diagnostic = (result.stderr.trim() || result.stdout.trim() || "no diagnostic output").slice(
    0,
    ESLINT_DIAGNOSTIC_LIMIT
  );
  return `ESLint failed (exit ${result.code}); skipped lint grounding. ${diagnostic}`;
}

/** Parse `eslint --format json` stdout into findings; tolerant of junk. */
export function parseEslintJson(root: string, stdout: string): Finding[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const findings: Finding[] = [];
  for (const entry of parsed as EslintFileResult[]) {
    if (!entry || !Array.isArray(entry.messages)) {
      continue;
    }
    for (const message of entry.messages) {
      if (!message || typeof message.message !== "string") {
        continue;
      }
      findings.push(eslintToFinding(root, entry, message));
    }
  }
  return findings;
}

/** Run ESLint over the changed JS/TS files, or note why it was skipped. */
async function runEslint(
  params: Required<Pick<GatherGroundingParams, "root" | "changedPaths">> & {
    exec: Exec;
    limits: Required<GroundingLimits>;
    changedLines?: GatherGroundingParams["changedLines"];
    secretScanPaths?: GatherGroundingParams["secretScanPaths"];
    trustWorkspace: boolean;
  }
): Promise<GroundingResult> {
  // Per-language linter selection (#5): ESLint handles the JS/TS family; other
  // languages degrade gracefully (no lint grounding) until their runners land (#16b).
  const files = safeRelativePaths(params.changedPaths).filter(isJavaScriptFamily);
  if (files.length === 0) {
    return { findings: [], notes: [] };
  }
  if (!params.trustWorkspace) {
    return {
      findings: [],
      notes: ["ESLint skipped because the workspace is not trusted to execute repository-defined lint code."]
    };
  }

  const limited = files.slice(0, params.limits.maxFiles);
  const notes: string[] = [];
  if (files.length > limited.length) {
    notes.push(`ESLint: linted ${limited.length}/${files.length} changed files (file cap).`);
  }

  const eslintScriptPath = join(params.root, "node_modules", "eslint", "bin", "eslint.js");
  // Invoke the JS entrypoint through this Node process instead of package
  // manager shims, avoiding registry resolution and shell/batch parsing.
  const result = await params.exec(
    process.execPath,
    ["--", eslintScriptPath, "--format", "json", "--no-error-on-unmatched-pattern", "--", ...limited],
    params.root
  );

  if (result.code === null) {
    return { findings: [], notes: [...notes, "ESLint: timed out; skipped."] };
  }
  const parsedFindings = parseEslintJson(params.root, result.stdout);
  const findings = filterToChangedLines(parsedFindings, changedLineLookup(params.changedLines));
  const hasJsonOutput = result.stdout.trim().startsWith("[");

  if (parsedFindings.length === 0 && isEslintUnavailable(result, eslintScriptPath)) {
    return { findings: [], notes: [...notes, "ESLint not available in the workspace; skipped lint grounding."] };
  }
  if (parsedFindings.length === 0 && (!hasJsonOutput || result.code !== 0 || result.stderr.trim())) {
    return { findings: [], notes: [...notes, eslintFailureNote(result)] };
  }

  if (findings.length > params.limits.maxFindings) {
    notes.push(`ESLint: kept ${params.limits.maxFindings}/${findings.length} findings (finding cap).`);
    return { findings: findings.slice(0, params.limits.maxFindings), notes };
  }
  if (findings.length > 0) {
    notes.push(`ESLint: ${findings.length} grounding finding(s).`);
  }
  return { findings, notes };
}

// ---------------------------------------------------------------------------
// Ruff (Python lint), Gitleaks (secret scan), and Semgrep (SAST) — backlog #16b.
//
// Unlike ESLint, these run with trusted built-in rules and no repo-discovered
// config/plugin code, so they run ungated even on untrusted PR checkouts — that's
// the point for secret scanning. They are selected per-language via the #5
// detector; absent tools skip gracefully.
//
// Ruleset sourcing for Semgrep (the #16b decision): a curated registry pack
// (DEFAULT_SEMGREP_CONFIG) is fetched from the registry — the same network reach
// osv-scanner already uses for OSV.dev — with metrics OFF so no project metadata
// is uploaded (this is why `--config auto`, which phones home, is not the
// default). A repo-supplied ruleset (e.g. `.semgrep.yml`) is honored only when
// the workspace is trusted, mirroring the ESLint gate.
// ---------------------------------------------------------------------------

/** True when a tool failed because its executable isn't installed. */
function commandUnavailable(result: ExecResult): boolean {
  if (result.code === 127) {
    return true;
  }
  const text = `${result.stderr}\n${result.stdout}`;
  return /(?:command not found|not recognized as an internal or external command|could not determine executable to run|spawn .* ENOENT)/i.test(text);
}

/** Build a compact, actionable failure note for a tool that ran but didn't produce usable output. */
function toolFailureNote(tool: string, result: ExecResult): string {
  const diagnostic = (result.stderr.trim() || result.stdout.trim() || "no diagnostic output").slice(
    0,
    ESLINT_DIAGNOSTIC_LIMIT
  );
  return `${tool} failed (exit ${result.code}); skipped grounding. ${diagnostic}`;
}

interface RuffMessage {
  code: string | null;
  message: string;
  filename: string;
  location?: { row?: number };
  end_location?: { row?: number };
}

/** Map a Ruff diagnostic to a low-severity, high-confidence lint grounding finding. */
function ruffToFinding(root: string, message: RuffMessage): Finding | undefined {
  const row = message.location?.row;
  if (!row || row <= 0) {
    return undefined;
  }
  const file = isAbsolute(message.filename) ? relative(root, message.filename) : message.filename;
  const endRow = message.end_location?.row;
  return {
    file: file.replace(/[\\/]/g, "/"),
    line: row,
    ...(endRow && endRow > row ? { endLine: endRow } : {}),
    severity: "minor" as Severity,
    category: "lint",
    title: message.code ?? "ruff",
    body: message.code ? `${message.message} (${message.code})` : message.message,
    confidence: 0.9
  };
}

/** Parse `ruff check --output-format json` stdout into findings; tolerant of junk. */
function parseRuffJson(root: string, stdout: string): Finding[] {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("[")) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const findings: Finding[] = [];
  for (const entry of parsed as RuffMessage[]) {
    if (entry && typeof entry.message === "string" && typeof entry.filename === "string") {
      const finding = ruffToFinding(root, entry);
      if (finding) {
        findings.push(finding);
      }
    }
  }
  return findings;
}

/** Run Ruff over the changed Python files, or note why it was skipped. */
async function runRuff(
  params: Required<Pick<GatherGroundingParams, "root" | "changedPaths">> & {
    exec: Exec;
    limits: Required<GroundingLimits>;
    changedLines?: GatherGroundingParams["changedLines"];
    secretScanPaths?: GatherGroundingParams["secretScanPaths"];
    trustWorkspace: boolean;
  }
): Promise<GroundingResult> {
  const files = safeRelativePaths(params.changedPaths).filter((p) => detectLanguage(p) === "python");
  if (files.length === 0) {
    return { findings: [], notes: [] };
  }

  const limited = files.slice(0, params.limits.maxFiles);
  const notes: string[] = [];
  if (files.length > limited.length) {
    notes.push(`Ruff: linted ${limited.length}/${files.length} changed files (file cap).`);
  }

  // `--isolated` ignores repo config; `--no-cache` avoids dirtying the checkout.
  // Avoid `--force-exclude` so directly passed changed files cannot be suppressed
  // by PR-supplied gitignore/exclude rules.
  const result = await params.exec(
    "ruff",
    ["check", "--output-format", "json", "--isolated", "--no-cache", "--", ...limited],
    params.root
  );

  if (result.code === null) {
    return { findings: [], notes: [...notes, "Ruff: timed out; skipped."] };
  }
  const parsed = parseRuffJson(params.root, result.stdout);
  const findings = filterToChangedLines(parsed, changedLineLookup(params.changedLines));
  const hasJson = result.stdout.trim().startsWith("[");

  if (parsed.length === 0 && commandUnavailable(result)) {
    return { findings: [], notes: [...notes, "Ruff not available in the workspace; skipped lint grounding."] };
  }
  // Ruff exits 0 (clean) or 1 (violations) on success. If exit 1 produced no
  // parseable diagnostics, surface it as a tool failure instead of a clean run.
  if (parsed.length === 0 && (!hasJson || result.code >= 1)) {
    return { findings: [], notes: [...notes, toolFailureNote("Ruff", result)] };
  }

  if (findings.length > params.limits.maxFindings) {
    notes.push(`Ruff: kept ${params.limits.maxFindings}/${findings.length} findings (finding cap).`);
    return { findings: findings.slice(0, params.limits.maxFindings), notes };
  }
  if (findings.length > 0) {
    notes.push(`Ruff: ${findings.length} grounding finding(s).`);
  }
  return { findings, notes };
}

interface GitleaksFinding {
  RuleID?: string;
  Description?: string;
  File?: string;
  StartLine?: number;
  EndLine?: number;
}

/** Map a Gitleaks leak to a critical security grounding finding (secret value already redacted). */
function gitleaksToFinding(finding: GitleaksFinding): Finding | undefined {
  const line = finding.StartLine;
  if (!finding.File || !line || line <= 0) {
    return undefined;
  }
  const endLine = finding.EndLine;
  const rule = finding.RuleID ?? "gitleaks";
  return {
    file: finding.File.replace(/[\\/]/g, "/"),
    line,
    ...(endLine && endLine > line ? { endLine } : {}),
    severity: "critical" as Severity,
    category: "security",
    title: rule,
    body: finding.Description ? `${finding.Description} (${rule})` : `Potential secret detected (${rule})`,
    confidence: 0.9
  };
}

/** Parse Gitleaks JSON report output into findings; tolerant of junk/banners. */
function parseGitleaksJson(stdout: string): Finding[] {
  const start = stdout.indexOf("[");
  if (start === -1) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start).trim());
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const findings: Finding[] = [];
  for (const entry of parsed as GitleaksFinding[]) {
    const finding = entry && typeof entry === "object" ? gitleaksToFinding(entry) : undefined;
    if (finding) {
      findings.push(finding);
    }
  }
  return findings;
}

const GITLEAKS_TRUSTED_ENV: NodeJS.ProcessEnv = {
  GITLEAKS_CONFIG: "",
  GITLEAKS_CONFIG_TOML: ""
};
const GITLEAKS_MAX_CONCURRENCY = 4;
const GITLEAKS_DISABLED_IGNORE_PATH = join(tmpdir(), "prowl-review-gitleaks-ignore-disabled");

/**
 * Run Gitleaks over changed files and keep leaks on changed lines. Each file is
 * passed as `--source` so Gitleaks falls back to its built-in default config
 * instead of loading a PR-supplied `.gitleaks.toml` from the checkout. `--redact`
 * keeps secret values out of the report (defense-in-depth with pipeline redaction).
 */
async function runGitleaks(
  params: Required<Pick<GatherGroundingParams, "root" | "changedPaths">> & {
    exec: Exec;
    limits: Required<GroundingLimits>;
    changedLines?: GatherGroundingParams["changedLines"];
    secretScanPaths?: GatherGroundingParams["secretScanPaths"];
    secretScanWholeFilePaths?: GatherGroundingParams["secretScanWholeFilePaths"];
    trustWorkspace: boolean;
  }
): Promise<GroundingResult> {
  const files = [
    ...new Set(
      safeRelativePaths([...(params.secretScanPaths ?? []), ...(params.secretScanWholeFilePaths ?? []), ...params.changedPaths])
    )
  ];
  if (files.length === 0) {
    return { findings: [], notes: [] };
  }

  const limited = files.slice(0, params.limits.maxFiles);
  const notes: string[] = [];
  if (files.length > limited.length) {
    notes.push(`Gitleaks: scanned ${limited.length}/${files.length} changed files (file cap).`);
  }

  // Scan files individually so a missing/deleted path cannot suppress findings
  // from other files and a repo-root `.gitleaks.toml` cannot silence leaks.
  const results = await mapWithConcurrency(limited, GITLEAKS_MAX_CONCURRENCY, (file) =>
    params.exec(
      "gitleaks",
      [
        "detect",
        "--no-git",
        "--source",
        file,
        "--report-format",
        "json",
        "--report-path",
        "-",
        "--redact",
        "--no-banner",
        "--ignore-gitleaks-allow",
        "--gitleaks-ignore-path",
        GITLEAKS_DISABLED_IGNORE_PATH
      ],
      params.root,
      { env: GITLEAKS_TRUSTED_ENV }
    )
  );

  const unavailableCount = results.filter(commandUnavailable).length;
  if (unavailableCount === results.length) {
    return { findings: [], notes: [...notes, "Gitleaks not available in the workspace; skipped secret grounding."] };
  }

  const parsedFindings: Finding[] = [];
  for (const result of results) {
    if (commandUnavailable(result)) {
      notes.push("Gitleaks not available for one file scan; skipped that file.");
      continue;
    }
    if (result.code === null) {
      notes.push("Gitleaks: timed out; skipped.");
      continue;
    }
    const parsed = parseGitleaksJson(result.stdout);
    const hasJson = result.stdout.includes("[");
    // Gitleaks exits 0 (no leaks) or 1 (leaks found) on success. If exit 1
    // produced no parseable report, surface it as a tool failure.
    if (parsed.length === 0 && (!hasJson || result.code >= 1)) {
      notes.push(toolFailureNote("Gitleaks", result));
      continue;
    }
    parsedFindings.push(...parsed);
  }

  const wholeFilePaths = new Set(safeRelativePaths(params.secretScanWholeFilePaths ?? []).map(normalizeRelativePath));
  const findings = filterToChangedLines(parsedFindings, changedLineLookup(params.changedLines), wholeFilePaths);

  if (findings.length > params.limits.maxFindings) {
    return {
      findings: findings.slice(0, params.limits.maxFindings),
      notes: [...notes, `Gitleaks: kept ${params.limits.maxFindings}/${findings.length} findings (finding cap).`]
    };
  }
  return {
    findings,
    notes: findings.length > 0 ? [...notes, `Gitleaks: ${findings.length} potential secret(s) on changed lines.`] : notes
  };
}

/** Default Semgrep ruleset: a curated registry pack (audited, low-noise). */
export const DEFAULT_SEMGREP_CONFIG = "p/default";

/** Languages Semgrep is run on (selected via the #5 detector). */
const SEMGREP_LANGUAGES = new Set<LanguageId>([
  "typescript",
  "javascript",
  "python",
  "go",
  "ruby",
  "java",
  "kotlin",
  "rust",
  "c",
  "cpp",
  "csharp",
  "php",
  "swift",
  "scala",
  "shell",
  "yaml",
  "json",
  "docker"
]);

/** Run Semgrep with metrics disabled (defense-in-depth with the `--metrics=off` flag). */
const SEMGREP_TRUSTED_ENV: NodeJS.ProcessEnv = { SEMGREP_SEND_METRICS: "off" };

/**
 * True when a ruleset reference resolves to a Semgrep registry pack that does not
 * let untrusted repo config choose an arbitrary remote/internal URL.
 */
function isRegistrySemgrepConfig(config: string): boolean {
  return /^(?:p|r)\//i.test(config) || config.toLowerCase() === "auto";
}

function isRemoteSemgrepConfig(config: string): boolean {
  return /^https?:\/\//i.test(config);
}

/** Map a Semgrep severity to a prowl-review severity. */
function mapSemgrepSeverity(severity: string | undefined): Severity {
  switch ((severity ?? "").toUpperCase()) {
    case "ERROR":
      return "major";
    case "WARNING":
      return "minor";
    default:
      return "info"; // INFO and anything unknown
  }
}

/** Map Semgrep's rule category metadata to a prowl-review finding category. */
function mapSemgrepCategory(metadataCategory: string | undefined): string {
  switch ((metadataCategory ?? "").toLowerCase()) {
    case "performance":
      return "performance";
    case "correctness":
      return "correctness";
    case "best-practice":
    case "maintainability":
    case "portability":
    case "compatibility":
      return "lint";
    case "security":
    default:
      return "security"; // Semgrep's headline value is SAST; default unknown to security
  }
}

const semgrepPositionSchema = z.object({ line: z.number().optional() }).passthrough();
const semgrepResultSchema = z
  .object({
    check_id: z.string().optional(),
    path: z.string().optional(),
    start: semgrepPositionSchema.optional(),
    end: semgrepPositionSchema.optional(),
    extra: z
      .object({
        message: z.string().optional(),
        severity: z.string().optional(),
        metadata: z.object({ category: z.string().optional() }).passthrough().optional()
      })
      .passthrough()
      .optional()
  })
  .passthrough();
const semgrepJsonSchema = z.object({ results: z.array(semgrepResultSchema).optional() }).passthrough();
type SemgrepResult = z.infer<typeof semgrepResultSchema>;
type SemgrepJson = z.infer<typeof semgrepJsonSchema>;

/** Map a Semgrep result to a high-confidence SAST grounding finding. */
function semgrepToFinding(root: string, result: SemgrepResult): Finding | undefined {
  const line = result.start?.line;
  if (!result.path || !line || line <= 0) {
    return undefined;
  }
  const file = (isAbsolute(result.path) ? relative(root, result.path) : result.path).replace(/[\\/]/g, "/");
  if (!file) {
    return undefined;
  }
  const endLine = result.end?.line;
  const ruleId = result.check_id ?? "semgrep";
  const message = (result.extra?.message ?? "Potential issue flagged by Semgrep").replace(/\s+/g, " ").trim();
  return {
    file,
    line,
    ...(endLine && endLine > line ? { endLine } : {}),
    severity: mapSemgrepSeverity(result.extra?.severity),
    category: mapSemgrepCategory(result.extra?.metadata?.category),
    title: ruleId,
    body: `${message} (${ruleId})`,
    confidence: 0.9
  };
}

/** Parse `semgrep scan --json` stdout into findings; tolerant of junk/banners. */
function parseSemgrepReport(stdout: string): SemgrepJson | undefined {
  const start = stdout.indexOf("{");
  if (start === -1) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(stdout.slice(start));
    const validated = semgrepJsonSchema.safeParse(parsed);
    return validated.success ? validated.data : undefined;
  } catch {
    return undefined;
  }
}

function semgrepFindingsFromReport(root: string, parsed: SemgrepJson | undefined): Finding[] {
  if (!Array.isArray(parsed?.results)) {
    return [];
  }
  const findings: Finding[] = [];
  for (const entry of parsed.results) {
    const finding = entry && typeof entry === "object" ? semgrepToFinding(root, entry) : undefined;
    if (finding) {
      findings.push(finding);
    }
  }
  return findings;
}

/** Parse `semgrep scan --json` stdout into findings; tolerant of junk/banners. */
export function parseSemgrepJson(root: string, stdout: string): Finding[] {
  return semgrepFindingsFromReport(root, parseSemgrepReport(stdout));
}

/** Run Semgrep over the changed source files, or note why it was skipped. */
async function runSemgrep(
  params: Required<Pick<GatherGroundingParams, "root" | "changedPaths">> & {
    exec: Exec;
    limits: Required<GroundingLimits>;
    changedLines?: GatherGroundingParams["changedLines"];
    secretScanPaths?: GatherGroundingParams["secretScanPaths"];
    trustWorkspace: boolean;
    semgrep?: SemgrepOptions;
  }
): Promise<GroundingResult> {
  if (params.semgrep?.enabled === false) {
    return { findings: [], notes: [] };
  }
  const files = safeRelativePaths(params.changedPaths).filter((path) => {
    const language = detectLanguage(path);
    return language !== undefined && SEMGREP_LANGUAGES.has(language);
  });
  if (files.length === 0) {
    return { findings: [], notes: [] };
  }

  // Resolve the ruleset. Registry packs run ungated; repo-supplied paths and
  // arbitrary remote URLs are honored only on a trusted workspace.
  const requestedConfig = params.semgrep?.config?.trim() || DEFAULT_SEMGREP_CONFIG;
  let config = requestedConfig;
  if (!isRegistrySemgrepConfig(requestedConfig)) {
    if (!params.trustWorkspace) {
      return {
        findings: [],
        notes: [
          `Semgrep skipped: the configured ruleset "${requestedConfig}" is a repo path or remote URL, which requires a trusted workspace; use --trust-workspace or a registry pack (e.g. p/default).`
        ]
      };
    }
    if (isRemoteSemgrepConfig(requestedConfig)) {
      config = requestedConfig;
    } else {
      const [safe] = safeRelativePaths([requestedConfig]);
      if (!safe) {
        return { findings: [], notes: ["Semgrep skipped: the configured ruleset path escapes the workspace."] };
      }
      config = safe;
    }
  }

  const limited = files.slice(0, params.limits.maxFiles);
  const notes: string[] = [];
  if (files.length > limited.length) {
    notes.push(`Semgrep: scanned ${limited.length}/${files.length} changed files (file cap).`);
  }

  // `--metrics=off` + `--disable-version-check` keep the run offline-friendly and
  // stop any project metadata from being uploaded. `--disable-nosem` prevents a
  // PR from hiding a changed-line finding with an inline Semgrep suppression. The
  // ruleset is the only thing fetched (cached after the first run).
  const result = await params.exec(
    "semgrep",
    [
      "scan",
      "--json",
      "--quiet",
      "--metrics=off",
      "--disable-version-check",
      "--disable-nosem",
      `--config=${config}`,
      "--",
      ...limited
    ],
    params.root,
    { env: SEMGREP_TRUSTED_ENV }
  );

  if (result.code === null) {
    return { findings: [], notes: [...notes, "Semgrep: timed out; skipped."] };
  }
  const semgrepReport = parseSemgrepReport(result.stdout);
  const parsed = semgrepFindingsFromReport(params.root, semgrepReport);
  const findings = filterToChangedLines(parsed, changedLineLookup(params.changedLines));
  const hasJsonReport = Array.isArray(semgrepReport?.results);

  if (parsed.length === 0 && commandUnavailable(result)) {
    return { findings: [], notes: [...notes, "Semgrep not available in the workspace; skipped SAST grounding."] };
  }
  // Semgrep exits 0 (clean) or 1 (findings) on success; exit > 1 is an error.
  // A non-parseable report on a non-clean exit is surfaced rather than dropped.
  if (result.code > 1) {
    return { findings, notes: [...notes, toolFailureNote("Semgrep", result)] };
  }
  if (parsed.length === 0 && !hasJsonReport) {
    return { findings: [], notes: [...notes, toolFailureNote("Semgrep", result)] };
  }

  if (findings.length > params.limits.maxFindings) {
    notes.push(`Semgrep: kept ${params.limits.maxFindings}/${findings.length} findings (finding cap).`);
    return { findings: findings.slice(0, params.limits.maxFindings), notes };
  }
  if (findings.length > 0) {
    notes.push(`Semgrep: ${findings.length} SAST grounding finding(s).`);
  }
  return { findings, notes };
}

// ---------------------------------------------------------------------------
// Dependency-CVE / license scanning via osv-scanner — backlog #34.
//
// When a dependency lockfile changes, scan it with osv-scanner (Google OSV):
// multi-ecosystem, lockfile-based (reads manifests as DATA, never executes repo
// code), JSON output. Like Ruff/Gitleaks it runs ungated and skips gracefully
// when the binary is absent. Known vulnerabilities become file-level findings;
// an optional SPDX allowlist additionally flags license-policy violations.
// ---------------------------------------------------------------------------

/** Lockfiles/manifests osv-scanner can scan, matched by basename (lowercased). */
const OSV_SCANNABLE_FILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "poetry.lock",
  "pipfile.lock",
  "pdm.lock",
  "requirements.txt",
  "go.mod",
  "cargo.lock",
  "gemfile.lock",
  "composer.lock",
  "pubspec.lock",
  "gradle.lockfile",
  "packages.lock.json",
  "mix.lock",
  "conan.lock",
  "pom.xml"
]);

/** Basename (lowercased, slashes normalized) for a repo-relative path. */
function baseName(path: string): string {
  const normalized = normalizeRelativePath(path);
  return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}

/** Select changed paths osv-scanner can scan (recognized lockfiles + `requirements*.txt`). */
export function dependencyScanTargets(changedPaths: string[]): string[] {
  const scannable = safeRelativePaths(changedPaths).filter((path) => {
    const base = baseName(path);
    return OSV_SCANNABLE_FILES.has(base) || /^requirements.*\.txt$/.test(base);
  });
  return [...new Set(scannable.map(normalizeRelativePath))];
}

interface OsvVulnerability {
  id?: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  database_specific?: { severity?: string };
  affected?: Array<{
    package?: { name?: string; ecosystem?: string };
    ranges?: Array<{ events?: Array<{ fixed?: string }> }>;
  }>;
}
interface OsvGroup {
  ids?: string[];
  max_severity?: string;
}
type OsvLicenseViolation =
  | string
  | {
      id?: string;
      license?: string | { id?: string; name?: string };
      license_id?: string;
      name?: string;
      spdx_id?: string;
    };
interface OsvPackageEntry {
  package?: { name?: string; version?: string; ecosystem?: string };
  vulnerabilities?: OsvVulnerability[];
  groups?: OsvGroup[];
  licenses?: string[];
  license_violations?: OsvLicenseViolation[];
}
interface OsvResult {
  source?: { path?: string };
  packages?: OsvPackageEntry[];
}

/** Map an OSV advisory to a prowl-review severity (GHSA label first, then CVSS score). */
function mapOsvSeverity(vuln: OsvVulnerability, group: OsvGroup | undefined): Severity {
  const label = vuln.database_specific?.severity?.toUpperCase();
  if (label) {
    if (label.startsWith("CRIT")) return "critical";
    if (label === "HIGH") return "major";
    if (label === "MODERATE" || label === "MEDIUM" || label === "LOW") return "minor";
  }
  const score = Number.parseFloat(group?.max_severity ?? "");
  if (!Number.isNaN(score)) {
    if (score >= 9) return "critical";
    if (score >= 7) return "major";
    if (score > 0) return "minor";
  }
  // Default vulnerabilities to major so they stay above the minor floor (#55).
  return "major";
}

/** Prefer a CVE alias for the advisory title, falling back to the OSV/GHSA id. */
function advisoryId(vuln: OsvVulnerability): string {
  const cve = (vuln.aliases ?? []).find((alias) => /^CVE-/i.test(alias));
  return cve ?? vuln.id ?? "advisory";
}

function affectedPackageMatches(
  affectedPackage: { name?: string; ecosystem?: string } | undefined,
  packageInfo: { name?: string; ecosystem?: string } | undefined
): boolean {
  if (!affectedPackage?.name && !affectedPackage?.ecosystem) {
    return true;
  }
  if (
    affectedPackage.name &&
    packageInfo?.name &&
    affectedPackage.name.toLowerCase() !== packageInfo.name.toLowerCase()
  ) {
    return false;
  }
  if (
    affectedPackage.ecosystem &&
    packageInfo?.ecosystem &&
    affectedPackage.ecosystem.toLowerCase() !== packageInfo.ecosystem.toLowerCase()
  ) {
    return false;
  }
  return true;
}

/** Best-effort "fixed in" version from the affected range for the reported package. */
function fixedVersion(
  vuln: OsvVulnerability,
  packageInfo: { name?: string; ecosystem?: string } | undefined
): string | undefined {
  for (const affected of vuln.affected ?? []) {
    if (!affectedPackageMatches(affected.package, packageInfo)) {
      continue;
    }
    for (const range of affected.ranges ?? []) {
      for (const event of range.events ?? []) {
        if (event.fixed) {
          return event.fixed;
        }
      }
    }
  }
  return undefined;
}

function licenseViolationId(violation: OsvLicenseViolation): string | undefined {
  if (typeof violation === "string") {
    return violation.trim() || undefined;
  }
  if (typeof violation.license === "string") {
    return violation.license.trim() || undefined;
  }
  return (
    violation.license?.id?.trim() ||
    violation.license?.name?.trim() ||
    violation.license_id?.trim() ||
    violation.spdx_id?.trim() ||
    violation.id?.trim() ||
    violation.name?.trim() ||
    undefined
  );
}

function explicitLicenseViolations(entry: OsvPackageEntry): string[] | undefined {
  if (!Array.isArray(entry.license_violations)) {
    return undefined;
  }
  const values = new Set<string>();
  for (const violation of entry.license_violations) {
    const id = licenseViolationId(violation);
    if (id) {
      values.add(id);
    }
  }
  return [...values];
}

function fallbackLicenseViolations(entry: OsvPackageEntry, allow: string[]): string[] {
  if (!Array.isArray(entry.licenses) || entry.licenses.length === 0) {
    return [];
  }
  return entry.licenses.filter((license) => {
    const value = license.trim().toLowerCase();
    return value.length > 0 && value !== "unknown" && !allow.includes(value);
  });
}

/** Parse osv-scanner `--format json` output into vulnerability + license findings. */
export function parseOsvJson(
  root: string,
  stdout: string,
  options: { allow?: string[] } = {}
): Finding[] {
  const start = stdout.indexOf("{");
  if (start === -1) {
    return [];
  }
  let parsed: { results?: OsvResult[] };
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch {
    return [];
  }
  const allow = options.allow?.map((license) => license.trim().toLowerCase()).filter(Boolean);
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const result of parsed.results ?? []) {
    const sourcePath = result.source?.path ?? "";
    const file = (isAbsolute(sourcePath) ? relative(root, sourcePath) : sourcePath).replace(/[\\/]/g, "/");
    if (!file) {
      continue;
    }
    for (const entry of result.packages ?? []) {
      const name = entry.package?.name ?? "unknown";
      const version = entry.package?.version ?? "?";
      const groupById = new Map<string, OsvGroup>();
      for (const group of entry.groups ?? []) {
        for (const id of group.ids ?? []) {
          groupById.set(id, group);
        }
      }
      for (const vuln of entry.vulnerabilities ?? []) {
        const id = advisoryId(vuln);
        const dedupe = `${file}|${name}@${version}|${id}`;
        if (seen.has(dedupe)) {
          continue;
        }
        seen.add(dedupe);
        const fixed = fixedVersion(vuln, entry.package);
        const summary = (vuln.summary ?? vuln.details ?? "known vulnerability").replace(/\s+/g, " ").trim();
        findings.push({
          file,
          severity: mapOsvSeverity(vuln, groupById.get(vuln.id ?? "")),
          category: "dependency",
          title: id,
          body:
            `${name}@${version}: ${summary}` +
            `${fixed ? `; fixed in ${fixed}` : ""} (${id}).`,
          confidence: 0.9
        });
      }
      // License policy: flag any dependency whose license falls outside the allowlist.
      if (allow && allow.length > 0) {
        const explicitViolations = explicitLicenseViolations(entry);
        const offending = explicitViolations ?? fallbackLicenseViolations(entry, allow);
        if (offending.length > 0) {
          const dedupe = `${file}|license|${name}`;
          if (!seen.has(dedupe)) {
            seen.add(dedupe);
            findings.push({
              file,
              severity: "major",
              category: "dependency",
              title: `license-policy: ${name}`,
              body:
                `${name}@${version} uses license ${offending.join(", ")}, ` +
                `which is not in the allowed list (${(options.allow ?? []).join(", ")}).`,
              confidence: 0.9
            });
          }
        }
      }
    }
  }
  return findings;
}

/** Scan changed dependency lockfiles with osv-scanner, or note why it was skipped. */
async function runDependencyScan(
  params: Required<Pick<GatherGroundingParams, "root" | "changedPaths">> & {
    exec: Exec;
    limits: Required<GroundingLimits>;
    dependencyScan?: DependencyScanOptions;
    dependencyPaths?: string[];
  }
): Promise<GroundingResult> {
  if (params.dependencyScan?.enabled === false) {
    return { findings: [], notes: [] };
  }
  const allTargets = dependencyScanTargets([...(params.dependencyPaths ?? []), ...params.changedPaths]);
  const targets = allTargets.slice(0, params.limits.maxFiles);
  const notes: string[] = [];
  if (allTargets.length > targets.length) {
    notes.push(`osv-scanner: scanning ${targets.length}/${allTargets.length} lockfiles (file cap).`);
  }
  if (targets.length === 0) {
    return { findings: [], notes };
  }

  const allow = params.dependencyScan?.licenses?.allow;
  const configDir = await mkdtemp(join(tmpdir(), "prowl-osv-"));
  const configPath = join(configDir, "osv-scanner.toml");
  const args = ["scan", "--format", "json", `--config=${configPath}`];
  if (allow && allow.length > 0) {
    // osv-scanner v2 emits per-package `licenses` for our own allowlist check.
    args.push(`--licenses=${allow.join(",")}`);
  }
  for (const target of targets) {
    args.push("-L", target);
  }

  let result: ExecResult;
  try {
    await chmod(configDir, 0o700);
    await writeFile(configPath, "", { mode: 0o600, flag: "wx" });
    result = await params.exec("osv-scanner", args, params.root);
  } finally {
    await rm(configDir, { recursive: true, force: true }).catch(() => undefined);
  }
  if (result.code === null) {
    return { findings: [], notes: ["osv-scanner: timed out; skipped dependency scanning."] };
  }
  const findings = parseOsvJson(params.root, result.stdout, { allow });
  const hasJson = result.stdout.includes("{");

  if (findings.length === 0 && commandUnavailable(result)) {
    return {
      findings: [],
      notes: ["osv-scanner not available in the workspace; skipped dependency CVE/license scanning (#34)."]
    };
  }
  if (findings.length === 0 && result.code === 128) {
    return { findings: [], notes: [...notes, "osv-scanner: no packages found in changed dependency files."] };
  }
  // osv-scanner exits 0 (clean) or 1 (vulns/violations found) on success. A
  // non-zero exit with no parseable report is a real failure, except v2's 128
  // no-packages result handled above.
  if (findings.length === 0 && (!hasJson || result.code > 1)) {
    return { findings: [], notes: [toolFailureNote("osv-scanner", result)] };
  }

  if (
    allow &&
    allow.length > 0 &&
    !result.stdout.includes("\"licenses\"") &&
    !result.stdout.includes("\"license_violations\"")
  ) {
    notes.push("osv-scanner: license data unavailable (scanner version may not support it); skipped license policy.");
  }
  if (findings.length > params.limits.maxFindings) {
    notes.push(`osv-scanner: kept ${params.limits.maxFindings}/${findings.length} dependency findings (finding cap).`);
    return { findings: findings.slice(0, params.limits.maxFindings), notes };
  }
  if (findings.length > 0) {
    notes.push(`osv-scanner: ${findings.length} dependency finding(s) on changed lockfiles (#34).`);
  }
  return { findings, notes };
}

/**
 * Run available linters over the changed files and return normalized grounding
 * findings + operational notes. ESLint (JS/TS, trusted-workspace only), Ruff
 * (Python), Gitleaks (secrets), Semgrep (SAST), and osv-scanner (dependency
 * CVE/license); extend by adding more runners here.
 */
export async function gatherGrounding(params: GatherGroundingParams): Promise<GroundingResult> {
  const limits: Required<GroundingLimits> = {
    maxFiles: params.limits?.maxFiles ?? DEFAULT_MAX_FILES,
    maxFindings: params.limits?.maxFindings ?? DEFAULT_MAX_FINDINGS,
    timeoutMs: params.limits?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  };
  const exec = params.exec ?? defaultExec(limits.timeoutMs);

  const runners = [runEslint, runRuff, runGitleaks, runSemgrep];
  const results = await Promise.all(
    runners.map((runner) =>
      runner({
        root: params.root,
        changedPaths: params.changedPaths,
        secretScanPaths: params.secretScanPaths,
        secretScanWholeFilePaths: params.secretScanWholeFilePaths,
        changedLines: params.changedLines,
        trustWorkspace: params.trustWorkspace === true,
        semgrep: params.semgrep,
        exec,
        limits
      }).catch(
        (error): GroundingResult => ({
          findings: [],
          notes: [`Linter grounding error: ${error instanceof Error ? error.message : String(error)}`]
        })
      )
    )
  );

  // Dependency-CVE / license scanning (#34) runs separately: it scans lockfiles
  // (data, not code) rather than the changed source files, so it isn't a linter.
  const dependencyResult = await runDependencyScan({
    root: params.root,
    changedPaths: params.changedPaths,
    dependencyPaths: params.dependencyPaths,
    dependencyScan: params.dependencyScan,
    exec,
    limits
  }).catch(
    (error): GroundingResult => ({
      findings: [],
      notes: [`Dependency scan error: ${error instanceof Error ? error.message : String(error)}`]
    })
  );

  return {
    findings: [...results.flatMap((r) => r.findings), ...dependencyResult.findings],
    notes: [...results.flatMap((r) => r.notes), ...dependencyResult.notes]
  };
}

/**
 * Render a compact, prompt-friendly summary of grounding findings so specialists
 * can reconcile with them instead of re-discovering. Untrusted linter text stays
 * data here (it is embedded in the user prompt, never the system block).
 */
export function buildGroundingSummary(findings: Finding[]): string {
  if (findings.length === 0) {
    return "";
  }
  const lines = findings.map((f) => {
    const loc = f.line ? `${f.file}:${f.line}` : f.file;
    return `- [${f.title}] ${loc} — ${f.body}`;
  });
  return [
    "# Known linter findings (deterministic; already detected)",
    "These were produced by the project's linters on the changed files. Reconcile with",
    "them: do not re-report them as your own findings, but factor them into your analysis.",
    ...lines
  ].join("\n");
}
