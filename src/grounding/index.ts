import { execFile } from "node:child_process";
import { join, relative, isAbsolute } from "node:path";
import type { Finding, Severity } from "../review/findings.js";
import { detectLanguage, isJavaScriptFamily } from "../review/language.js";
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

/** Injectable command runner (defaults to a confined `execFile`). */
export type Exec = (command: string, args: string[], cwd: string) => Promise<ExecResult>;

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

export interface GatherGroundingParams {
  /** Repo checkout root the linters run inside. */
  root: string;
  /** Repo-relative changed file paths (new side). */
  changedPaths: string[];
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
}

export interface GroundingResult {
  /** Deterministic findings normalized from linter output. */
  findings: Finding[];
  /** Operational notes (skips, truncation, errors) — surfaced, never silent. */
  notes: string[];
}

/** Default command runner: `execFile` confined to `cwd`, bounded output + time. */
function defaultExec(timeoutMs: number): Exec {
  return (command, args, cwd) =>
    new Promise<ExecResult>((resolve) => {
      execFile(
        command,
        args,
        { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
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
    const normalized = file.replace(/^\.\//, "").replace(/\\/g, "/");
    lookup.set(normalized, new Set(lines.filter((line) => Number.isInteger(line) && line > 0)));
  }
  return lookup;
}

/** Keep only findings whose line range intersects the new-side changed lines. */
function filterToChangedLines(findings: Finding[], changedLines: Map<string, Set<number>> | undefined): Finding[] {
  if (!changedLines) {
    return findings;
  }
  return findings.filter((finding) => {
    if (!finding.line) {
      return false;
    }
    const lines = changedLines.get(finding.file);
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
// Ruff (Python lint) and Gitleaks (secret scan) — backlog #16b.
//
// Unlike ESLint, these run with their OWN rules (a single binary, no repo-defined
// plugin code), so they run ungated even on untrusted PR checkouts — that's the
// point for secret scanning. They are selected per-language via the #5 detector;
// absent tools skip gracefully. (Semgrep is deferred: its rulesets need a network
// registry or repo rules — a separate sourcing decision.)
// ---------------------------------------------------------------------------

/** True when a tool failed because its executable isn't installed. */
function commandUnavailable(result: ExecResult): boolean {
  if (result.code === 127) {
    return true;
  }
  const text = `${result.stderr}\n${result.stdout}`;
  return /(?:command not found|not recognized as an internal or external command|no such file or directory|could not determine executable to run|spawn .* ENOENT|ENOENT)/i.test(
    text
  );
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

  // `--force-exclude` so a repo's own exclude config can't accidentally re-include
  // odd paths; `--` terminates flags before the file list.
  const result = await params.exec(
    "ruff",
    ["check", "--output-format", "json", "--force-exclude", "--", ...limited],
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
  // Ruff exits 0 (clean) or 1 (violations) on success; 2 signals a real error.
  if (parsed.length === 0 && (!hasJson || result.code >= 2)) {
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

/**
 * Run Gitleaks over the workspace and keep leaks on changed lines. Gitleaks takes
 * a directory (not a file list), so it scans the checkout and findings are then
 * filtered to the PR's changed lines. `--redact` keeps secret values out of the
 * report (defense-in-depth with the pipeline's own redaction).
 */
async function runGitleaks(
  params: Required<Pick<GatherGroundingParams, "root" | "changedPaths">> & {
    exec: Exec;
    limits: Required<GroundingLimits>;
    changedLines?: GatherGroundingParams["changedLines"];
    trustWorkspace: boolean;
  }
): Promise<GroundingResult> {
  if (safeRelativePaths(params.changedPaths).length === 0) {
    return { findings: [], notes: [] };
  }

  const result = await params.exec(
    "gitleaks",
    ["detect", "--no-git", "--source", ".", "--report-format", "json", "--report-path", "/dev/stdout", "--redact", "--no-banner"],
    params.root
  );

  if (result.code === null) {
    return { findings: [], notes: ["Gitleaks: timed out; skipped."] };
  }
  const parsed = parseGitleaksJson(result.stdout);
  const findings = filterToChangedLines(parsed, changedLineLookup(params.changedLines));
  const hasJson = result.stdout.includes("[");

  if (parsed.length === 0 && commandUnavailable(result)) {
    return { findings: [], notes: ["Gitleaks not available in the workspace; skipped secret grounding."] };
  }
  // Gitleaks exits 0 (no leaks) or 1 (leaks found) on success; higher codes are errors.
  if (parsed.length === 0 && (!hasJson || result.code > 1)) {
    return { findings: [], notes: [toolFailureNote("Gitleaks", result)] };
  }

  if (findings.length > params.limits.maxFindings) {
    return {
      findings: findings.slice(0, params.limits.maxFindings),
      notes: [`Gitleaks: kept ${params.limits.maxFindings}/${findings.length} findings (finding cap).`]
    };
  }
  return {
    findings,
    notes: findings.length > 0 ? [`Gitleaks: ${findings.length} potential secret(s) on changed lines.`] : []
  };
}

/**
 * Run available linters over the changed files and return normalized grounding
 * findings + operational notes. ESLint (JS/TS, trusted-workspace only), Ruff
 * (Python), and Gitleaks (secrets); extend by adding more runners here.
 */
export async function gatherGrounding(params: GatherGroundingParams): Promise<GroundingResult> {
  const limits: Required<GroundingLimits> = {
    maxFiles: params.limits?.maxFiles ?? DEFAULT_MAX_FILES,
    maxFindings: params.limits?.maxFindings ?? DEFAULT_MAX_FINDINGS,
    timeoutMs: params.limits?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  };
  const exec = params.exec ?? defaultExec(limits.timeoutMs);

  const runners = [runEslint, runRuff, runGitleaks];
  const results = await Promise.all(
    runners.map((runner) =>
      runner({
        root: params.root,
        changedPaths: params.changedPaths,
        changedLines: params.changedLines,
        trustWorkspace: params.trustWorkspace === true,
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

  return {
    findings: results.flatMap((r) => r.findings),
    notes: results.flatMap((r) => r.notes)
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
