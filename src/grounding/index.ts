import { execFile } from "node:child_process";
import { relative, isAbsolute } from "node:path";
import type { Finding, Severity } from "../review/findings.js";
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
          const code =
            error && typeof (error as NodeJS.ErrnoException & { code?: number }).code === "number"
              ? ((error as unknown as { code: number }).code)
              : error
                ? null
                : 0;
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

const ESLINT_EXTENSIONS = /\.(?:m|c)?[jt]sx?$/i;

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
    file: file.replace(/\\/g, "/"),
    ...(message.line ? { line: message.line } : {}),
    ...(message.endLine && message.line && message.endLine > message.line ? { endLine: message.endLine } : {}),
    severity,
    category: "lint",
    title: message.ruleId ?? "eslint",
    body: message.ruleId ? `${message.message} (${message.ruleId})` : message.message,
    confidence: 0.9
  };
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
  }
): Promise<GroundingResult> {
  const files = safeRelativePaths(params.changedPaths).filter((p) => ESLINT_EXTENSIONS.test(p));
  if (files.length === 0) {
    return { findings: [], notes: [] };
  }

  const limited = files.slice(0, params.limits.maxFiles);
  const notes: string[] = [];
  if (files.length > limited.length) {
    notes.push(`ESLint: linted ${limited.length}/${files.length} changed files (file cap).`);
  }

  // `npx --no-install` runs the repo's own ESLint without ever installing it, so
  // an absent linter degrades gracefully instead of pulling from the network.
  const result = await params.exec("npx", ["--no-install", "eslint", "--format", "json", ...limited], params.root);

  if (result.code === null) {
    return { findings: [], notes: [...notes, "ESLint: timed out; skipped."] };
  }
  // npx exits 127-ish (or prints an error) when eslint isn't installed; with no
  // parseable JSON we treat it as "not available" rather than a hard failure.
  const findings = parseEslintJson(params.root, result.stdout);
  if (findings.length === 0 && !result.stdout.trim().startsWith("[")) {
    return { findings: [], notes: [...notes, "ESLint not available in the workspace; skipped lint grounding."] };
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

/**
 * Run available linters over the changed files and return normalized grounding
 * findings + operational notes. Currently ESLint (JS/TS); extend by adding more
 * runners here.
 */
export async function gatherGrounding(params: GatherGroundingParams): Promise<GroundingResult> {
  const limits: Required<GroundingLimits> = {
    maxFiles: params.limits?.maxFiles ?? DEFAULT_MAX_FILES,
    maxFindings: params.limits?.maxFindings ?? DEFAULT_MAX_FINDINGS,
    timeoutMs: params.limits?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  };
  const exec = params.exec ?? defaultExec(limits.timeoutMs);

  const runners = [runEslint];
  const results = await Promise.all(
    runners.map((runner) =>
      runner({ root: params.root, changedPaths: params.changedPaths, exec, limits }).catch(
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
