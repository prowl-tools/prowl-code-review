import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

import {
  type CodexOptions,
  type CompletionRequest,
  type CompletionResult,
  type Provider,
  type ProviderConfig,
  type TokenUsage,
  type ToolCompletionRequest,
  type ToolCompletionResult
} from "./types.js";
import { codexLockPath, resolveCodexHome, withCodexLock, type AcquireLockOptions } from "./codex-lock.js";

/**
 * Codex (ChatGPT subscription) provider — backlog #45.
 *
 * Inference spawns the official first-party `codex` binary (`codex exec`), signed
 * in with ChatGPT via `codex login`; it NEVER calls an OpenAI/ChatGPT backend
 * endpoint directly. Auth lives in `$CODEX_HOME` and is resolved by the `codex`
 * binary itself — prowl-review never reads, copies, or logs `auth.json`.
 *
 * The prompt is delivered on **stdin** (`codex exec … -`) which is then closed —
 * a non-TTY stdin left open makes `codex exec` block reading more input, and argv
 * has ARG_MAX limits a large review prompt would blow. Events arrive as JSONL on
 * stdout (`--json`); the **last** `agent_message` is the answer (Codex can emit a
 * premature message before a tool call), and `turn.completed.usage` maps to
 * {@link TokenUsage}.
 *
 * Native JSON output: `--output-schema` uses OpenAI *strict* json_schema mode
 * (every object needs `additionalProperties:false` and all-required keys), which
 * the open-ended review findings array cannot express — so, exactly like
 * `openai.ts`, `complete()` relies on the prompt's JSON contract plus the
 * caller's tolerant parse-and-retry, adding a light "JSON only" nudge. The strict
 * schema is used only where prowl-review controls the shape (the retrieval
 * bundle; see `context/codex-retrieval.ts`).
 *
 * Agentic cross-file retrieval has no `completeWithTools` mapping (Codex runs its
 * own tool loop) — it goes through the `deps.gatherContext` seam instead.
 */

export const CODEX_BINARY = "codex";

const VALID_EFFORTS = new Set(["minimal", "low", "medium", "high"]);
/** Cost-first default: matches the specialist fan-out that dominates a review. */
export const DEFAULT_CODEX_EFFORT = "low";

/** Default single-`codex exec` wall-clock timeout (ms). */
export const DEFAULT_CODEX_TIMEOUT_MS = 600_000;

/** Parse a positive-integer env value; undefined when unset/blank/invalid. */
function parsePositiveIntEnv(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Parse a boolean-ish env value (`true/1/yes/on` vs `false/0/no/off`); undefined otherwise. */
function parseBoolEnv(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "") {
    return undefined;
  }
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

/**
 * Resolve Codex options from env + `.prowl-review.yml` `codex:` defaults (#45).
 * Precedence: env var > config default > built-in default. Effort falls back to
 * {@link DEFAULT_CODEX_EFFORT} for unknown values; the lock defaults on.
 */
export function resolveCodexOptions(
  env: NodeJS.ProcessEnv = process.env,
  defaults?: Partial<CodexOptions>
): CodexOptions {
  const rawEffort = env.PROWL_CODEX_EFFORT?.trim() || defaults?.effort?.trim() || DEFAULT_CODEX_EFFORT;
  const effort = VALID_EFFORTS.has(rawEffort) ? rawEffort : DEFAULT_CODEX_EFFORT;
  const lock = parseBoolEnv(env.PROWL_CODEX_LOCK) ?? defaults?.lock ?? true;
  const timeoutMs =
    parsePositiveIntEnv(env.PROWL_CODEX_TIMEOUT_MS) ?? defaults?.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS;
  const lockTimeoutMs =
    parsePositiveIntEnv(env.PROWL_CODEX_LOCK_TIMEOUT_MS) ?? defaults?.lockTimeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS;
  return { effort, lock, timeoutMs, lockTimeoutMs, codexHome: resolveCodexHome(env, defaults?.codexHome) };
}

/** Build the `codex exec` argv (prompt is delivered on stdin via the trailing `-`). */
export function buildCodexArgs(params: {
  model: string;
  effort: string;
  cwd: string;
  schemaPath?: string;
  sandbox?: string;
}): string[] {
  return [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--sandbox",
    params.sandbox ?? "read-only",
    "-C",
    params.cwd,
    "--skip-git-repo-check",
    "-m",
    params.model,
    "-c",
    // TOML value: a bare string is invalid, so the enum is quoted.
    `model_reasoning_effort="${params.effort}"`,
    "--json",
    ...(params.schemaPath ? ["--output-schema", params.schemaPath] : []),
    "-"
  ];
}

interface CodexUsageRaw {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

/**
 * Map `turn.completed.usage` → {@link TokenUsage}. `input_tokens` includes the
 * cached portion (OpenAI convention), so the uncached remainder is reported;
 * reasoning tokens are billed output and fold into `outputTokens`.
 */
export function mapCodexUsage(usage: CodexUsageRaw | undefined): TokenUsage {
  const cachedInputTokens = usage?.cached_input_tokens ?? 0;
  const inputTokens = Math.max((usage?.input_tokens ?? 0) - cachedInputTokens, 0);
  const cacheWrite = usage?.cache_write_input_tokens ?? 0;
  const outputTokens = (usage?.output_tokens ?? 0) + (usage?.reasoning_output_tokens ?? 0);
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    ...(cacheWrite > 0 ? { cacheWriteInputTokens: cacheWrite } : {})
  };
}

export interface ParsedCodexEvents {
  /** Every `agent_message` text, in order (take the LAST as the answer). */
  agentMessages: string[];
  /** Mapped usage from `turn.completed`, or empty when absent. */
  usage: TokenUsage;
  /** True when a `turn.completed` event was seen (the turn actually finished). */
  completed: boolean;
  /** Error text from `error` / `turn.failed` events, when present. */
  errorMessage?: string;
}

/** Parse the JSONL event stream from `codex exec --json` on stdout. */
export function parseCodexEvents(stdout: string): ParsedCodexEvents {
  const agentMessages: string[] = [];
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  let errorMessage: string | undefined;
  let completed = false;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = event.type;
    if (type === "item.completed") {
      const item = event.item as { type?: string; text?: string } | undefined;
      if (item?.type === "agent_message" && typeof item.text === "string") {
        agentMessages.push(item.text);
      }
    } else if (type === "turn.completed") {
      usage = mapCodexUsage(event.usage as CodexUsageRaw | undefined);
      completed = true;
    } else if (type === "error") {
      if (typeof event.message === "string") {
        errorMessage = event.message;
      }
    } else if (type === "turn.failed") {
      const err = event.error as { message?: string } | undefined;
      if (typeof err?.message === "string") {
        errorMessage = err.message;
      }
    }
  }

  return { agentMessages, usage, completed, ...(errorMessage ? { errorMessage } : {}) };
}

/** Base class for Codex spawn/auth/limit errors so callers can branch on `kind`. */
export class CodexError extends Error {
  readonly kind: "unavailable" | "unauthenticated" | "usage-limit" | "failed";
  constructor(message: string, kind: CodexError["kind"]) {
    super(message);
    this.name = "CodexError";
    this.kind = kind;
  }
}

const RUN_LOGIN = "run `codex login` on this machine (the runner) to sign in with ChatGPT";

function unauthenticatedError(): CodexError {
  return new CodexError(
    `Codex is not authenticated. ${RUN_LOGIN}. prowl-review spawns the official \`codex\` ` +
      `binary and never reads or copies auth.json.`,
    "unauthenticated"
  );
}

/** Classify Codex error output into an actionable {@link CodexError}. */
export function classifyCodexError(text: string): CodexError {
  const lower = text.toLowerCase();
  if (/usage limit|rate limit|quota|\b429\b|too many requests|resets? (?:at|in)/.test(lower)) {
    const reset = /resets?\s+(?:at|in)\s+([^.\n"]+)/i.exec(text)?.[1]?.trim();
    return new CodexError(
      `Codex subscription usage limit reached${reset ? ` — resets ${reset}` : ""}. ` +
        `Retry with \`@prowl-review review\` after the window resets. prowl-review does not ` +
        `meter usage; this is your ChatGPT plan allowance (see #65).`,
      "usage-limit"
    );
  }
  // Anchor to concrete Codex/OpenAI auth phrasings so a path or message that
  // merely contains "login" can't misclassify a generic failure as auth.
  if (/not logged in|not authenticated|codex login|unauthorized|\b401\b|no credentials|invalid api key/.test(lower)) {
    return unauthenticatedError();
  }
  return new CodexError(
    `Codex exec failed: ${text.trim() || "no agent message and no usage were returned."} (${RUN_LOGIN} if this is an auth failure).`,
    "failed"
  );
}

/** Minimal child-process surface `runCodexExec` needs; the real `spawn` satisfies it. */
export interface CodexProcess {
  // `on` is included so we can swallow async stdin EPIPE (codex exiting before it
  // reads a large prompt) instead of letting it crash the process.
  stdin: Pick<Writable, "write" | "end" | "on">;
  stdout: Pick<Readable, "on">;
  stderr: Pick<Readable, "on">;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: (code: number | null) => void): void;
  /** Terminate the child (for the exec timeout). */
  kill(signal?: NodeJS.Signals | number): void;
}

export type CodexSpawner = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv }
) => CodexProcess;

const realSpawn: CodexSpawner = (command, args, options) =>
  spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: options.env }) as unknown as CodexProcess;

export interface RunCodexExecParams {
  /** Full prompt written to stdin (system + user content already concatenated). */
  prompt: string;
  model: string;
  effort: string;
  /** Working root for `-C` (a fresh scratch dir under a read-only sandbox). */
  cwd: string;
  /** Resolved CODEX_HOME (passed through to the spawned binary's env). */
  codexHome: string;
  /** Optional strict JSON-Schema file for `--output-schema`. */
  schemaPath?: string;
  sandbox?: string;
  /** Kill the child after this many ms (SIGTERM, then SIGKILL after the grace). */
  timeoutMs?: number;
  /** Grace between SIGTERM and SIGKILL on timeout, ms. Default 5000. */
  killGraceMs?: number;
  /** Injectable spawn (tests). */
  spawn?: CodexSpawner;
  /** Environment forwarded to the child (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
}

export interface CodexExecResult {
  /** The last `agent_message` text. */
  text: string;
  usage: TokenUsage;
}

/** Spawn `codex exec`, feed the prompt on stdin, and return the last agent message + usage. */
export async function runCodexExec(params: RunCodexExecParams): Promise<CodexExecResult> {
  const spawner = params.spawn ?? realSpawn;
  const env = { ...(params.env ?? process.env), CODEX_HOME: params.codexHome };
  const args = buildCodexArgs({
    model: params.model,
    effort: params.effort,
    cwd: params.cwd,
    ...(params.schemaPath ? { schemaPath: params.schemaPath } : {}),
    ...(params.sandbox ? { sandbox: params.sandbox } : {})
  });

  const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number | null }>(
    (resolve, reject) => {
      let child: CodexProcess;
      try {
        child = spawner(CODEX_BINARY, args, { env });
      } catch (error) {
        reject(spawnFailure(error));
        return;
      }
      let out = "";
      let err = "";
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const clearTimers = () => {
        if (killTimer) {
          clearTimeout(killTimer);
        }
        if (graceTimer) {
          clearTimeout(graceTimer);
        }
      };
      child.stdout.on("data", (chunk: Buffer | string) => {
        out += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        err += chunk.toString();
      });
      // If codex exits before consuming a large prompt, the stdin write raises an
      // async EPIPE. Swallow it here — the close/timeout path reports the real
      // failure — so it can't become an uncaught exception that crashes the review.
      child.stdin.on("error", () => {});
      child.on("error", (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimers();
        reject(spawnFailure(error));
      });
      child.on("close", (exitCode: number | null) => {
        // The process is gone; cancel any pending SIGKILL even if a timeout already
        // rejected this promise.
        if (graceTimer) {
          clearTimeout(graceTimer);
        }
        if (settled) {
          return;
        }
        settled = true;
        clearTimers();
        resolve({ stdout: out, stderr: err, code: exitCode });
      });
      if (params.timeoutMs && params.timeoutMs > 0) {
        killTimer = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          try {
            child.kill("SIGTERM");
          } catch {
            // Child may already be gone.
          }
          // Escalate to SIGKILL if SIGTERM doesn't land within the grace window.
          graceTimer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              // Already exited.
            }
          }, params.killGraceMs ?? 5000);
          reject(
            new CodexError(
              `Codex exec timed out after ${params.timeoutMs}ms and was killed. ` +
                `Raise codex.timeoutMs / PROWL_CODEX_TIMEOUT_MS if reviews legitimately run this long.`,
              "failed"
            )
          );
        }, params.timeoutMs);
      }
      // Deliver the prompt, then CLOSE stdin so `codex exec` stops reading input.
      try {
        child.stdin.write(params.prompt);
        child.stdin.end();
      } catch (error) {
        if (!settled) {
          settled = true;
          clearTimers();
          reject(spawnFailure(error));
        }
      }
    }
  );

  const parsed = parseCodexEvents(stdout);
  const errText = parsed.errorMessage ?? stderr;
  // A premature `agent_message` before a failed turn must NOT read as success:
  // fail on any error event, a non-zero exit, or a turn that never completed but
  // left an error/stderr signal — regardless of whether agent messages exist.
  const failed =
    parsed.errorMessage !== undefined ||
    (code ?? 0) !== 0 ||
    (!parsed.completed && errText.trim() !== "");
  if (failed) {
    throw classifyCodexError(errText);
  }
  const last = parsed.agentMessages.at(-1);
  if (last === undefined) {
    throw classifyCodexError(errText);
  }
  return { text: last, usage: parsed.usage };
}

/** ENOENT (binary missing) → a clear "install + login" error; else rethrow classified. */
function spawnFailure(error: unknown): CodexError {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") {
    return new CodexError(
      `Codex CLI not found on PATH. Install it and ${RUN_LOGIN}, then retry. prowl-review ` +
        `spawns the official \`codex\` binary; it never calls OpenAI endpoints directly.`,
      "unavailable"
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return classifyCodexError(message);
}

/** Assemble the single prompt string from a completion request. */
export function composeCodexPrompt(request: CompletionRequest): string {
  const parts: string[] = [];
  if (request.system) {
    parts.push(request.system);
  }
  parts.push(request.prompt);
  if (request.responseFormat === "json") {
    // Codex is agentic and chatty; reinforce the caller's JSON contract so the
    // final message is parseable (the array shape can't be a strict schema).
    parts.push("Output only the JSON value described above — no prose, no explanation, no markdown code fences.");
  }
  return parts.join("\n\n");
}

/** Resolve the lock config for a codex run from its {@link CodexOptions}. */
export function codexLockConfig(codex: CodexOptions, acquireOptions?: AcquireLockOptions) {
  const codexHome = codex.codexHome ?? resolveCodexHome();
  const childTimeout = codex.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS;
  // Keep the live-holder max-age backstop safely above one child exec timeout so a
  // holder mid-`codex exec` is never reclaimed before its own timeout can fire.
  const resolvedAcquireOptions: AcquireLockOptions = {
    timeoutMs: codex.lockTimeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS,
    maxAgeMs: childTimeout + 60_000,
    ...acquireOptions
  };
  return {
    enabled: codex.lock !== false,
    lockPath: codexLockPath(codexHome),
    acquireOptions: resolvedAcquireOptions
  };
}

async function completeCodex(request: CompletionRequest, config: ProviderConfig): Promise<CompletionResult> {
  const codex = config.codex ?? resolveCodexOptions();
  const codexHome = codex.codexHome ?? resolveCodexHome();
  const prompt = composeCodexPrompt(request);

  const result = await withCodexLock(codexLockConfig(codex), async () => {
    const cwd = mkdtempSync(join(tmpdir(), "prowl-codex-"));
    try {
      return await runCodexExec({
        prompt,
        model: config.model,
        effort: codex.effort ?? DEFAULT_CODEX_EFFORT,
        cwd,
        codexHome,
        ...(codex.timeoutMs ? { timeoutMs: codex.timeoutMs } : {})
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  return { text: result.text, usage: result.usage, provider: "codex", model: config.model };
}

function completeCodexTools(
  _request: ToolCompletionRequest,
  _config: ProviderConfig
): Promise<ToolCompletionResult> {
  return Promise.reject(
    new CodexError(
      "codex provider does not support completeWithTools — Codex runs its own tool loop. " +
        "Agentic cross-file retrieval for codex goes through the gatherContext seam " +
        "(gatherCodexContext in context/codex-retrieval.ts). This is expected, not a bug.",
      "failed"
    )
  );
}

/**
 * Codex provider. Spawns the first-party `codex` CLI under a read-only sandbox in
 * a fresh scratch dir, serialized machine-wide by the Codex lock (#45).
 */
export const codexProvider: Provider = {
  name: "codex",
  complete: completeCodex,
  completeWithTools: completeCodexTools
};
