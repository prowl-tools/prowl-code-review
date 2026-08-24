import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertCodexActionSupported,
  buildCodexArgs,
  classifyCodexError,
  codexProvider,
  composeCodexPrompt,
  CodexError,
  mapCodexUsage,
  parseCodexEvents,
  resolveCodexOptions,
  runCodexExec,
  DEFAULT_CODEX_EFFORT,
  type CodexProcess,
  type CodexSpawner
} from "../src/providers/codex.js";
import { resolveProviderConfig } from "../src/providers/index.js";
import { resolveEnsembleConfigs } from "../src/providers/ensemble.js";
import { modelFailbackChain } from "../src/providers/failback.js";
import { estimateCost, formatCostLine } from "../src/cost/pricing.js";

const ORIGINAL_ENV = process.env;
let tempDirs: string[] = [];

/** JSONL string from a list of codex events. */
function jsonl(...events: unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

interface FakeCodexOptions {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  /** Emit `child.on("error")` with this (e.g. ENOENT) instead of closing. */
  spawnError?: NodeJS.ErrnoException;
  /** Emit an async `stdin` error (e.g. EPIPE) after the prompt is written. */
  stdinError?: Error;
  /** Never emit `close` — used to exercise the exec timeout. */
  neverClose?: boolean;
}

interface FakeCodexCall {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  stdin: string;
  stdinClosed: boolean;
  killed: Array<NodeJS.Signals | number | undefined>;
}

/** A spawn stub that records argv/stdin/kill and replays canned stdout/stderr. */
function makeFakeCodex(opts: FakeCodexOptions): { spawner: CodexSpawner; calls: FakeCodexCall[] } {
  const calls: FakeCodexCall[] = [];
  const spawner: CodexSpawner = (command, args, options) => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const stdin = new EventEmitter();
    const child = new EventEmitter();
    const call: FakeCodexCall = { command, args, env: options.env, stdin: "", stdinClosed: false, killed: [] };
    calls.push(call);

    const fake: CodexProcess = {
      stdin: {
        write: (chunk: string) => {
          call.stdin += chunk;
          if (opts.stdinError) {
            setImmediate(() => stdin.emit("error", opts.stdinError));
          }
          return true;
        },
        end: () => {
          call.stdinClosed = true;
          if (opts.neverClose) {
            return;
          }
          setImmediate(() => {
            if (opts.spawnError) {
              child.emit("error", opts.spawnError);
              return;
            }
            if (opts.stdout) {
              stdout.emit("data", Buffer.from(opts.stdout));
            }
            if (opts.stderr) {
              stderr.emit("data", Buffer.from(opts.stderr));
            }
            child.emit("close", opts.code ?? 0);
          });
        },
        on: (event: string, cb: (arg: unknown) => void) => stdin.on(event, cb)
      } as CodexProcess["stdin"],
      stdout: { on: (event: string, cb: (chunk: Buffer) => void) => stdout.on(event, cb) } as CodexProcess["stdout"],
      stderr: { on: (event: string, cb: (chunk: Buffer) => void) => stderr.on(event, cb) } as CodexProcess["stderr"],
      on: (event: "error" | "close", cb: (arg: never) => void) => {
        child.on(event, cb as (arg: unknown) => void);
      },
      kill: (signal?: NodeJS.Signals | number) => {
        call.killed.push(signal);
        if (!opts.neverClose) {
          return;
        }
        // A real SIGKILL makes the process exit; reflect that so graceTimer clears.
        if (signal === "SIGKILL") {
          setImmediate(() => child.emit("close", null));
        }
      }
    };
    return fake;
  };
  return { spawner, calls };
}

const AGENT_MSG = (text: string) => ({ type: "item.completed", item: { id: "i", type: "agent_message", text } });
const USAGE = (usage: Record<string, number>) => ({ type: "turn.completed", usage });

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.GITHUB_ACTIONS;
  delete process.env.PROWL_RUNNER_ENVIRONMENT;
  delete process.env.RUNNER_ENVIRONMENT;
  delete process.env.PROWL_REPOSITORY_VISIBILITY;
  delete process.env.GITHUB_REPOSITORY_VISIBILITY;
  delete process.env.PROWL_REPOSITORY_PRIVATE;
  delete process.env.GITHUB_REPOSITORY_PRIVATE;
  delete process.env.GITHUB_EVENT_PATH;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = ORIGINAL_ENV;
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "prowl-codex-provider-"));
  tempDirs.push(dir);
  return dir;
}

describe("buildCodexArgs", () => {
  it("emits the read-only, ephemeral, keyless spawn argv with stdin sentinel", () => {
    const args = buildCodexArgs({ model: "gpt-5.5", effort: "low", cwd: "/scratch" });
    expect(args).toEqual([
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--sandbox",
      "read-only",
      "-C",
      "/scratch",
      "--skip-git-repo-check",
      "-m",
      "gpt-5.5",
      "-c",
      'model_reasoning_effort="low"',
      "--json",
      "-"
    ]);
  });

  it("adds --output-schema before the stdin sentinel when a schema path is given", () => {
    const args = buildCodexArgs({ model: "gpt-5.5", effort: "medium", cwd: "/s", schemaPath: "/tmp/s.json" });
    expect(args).toContain("--output-schema");
    expect(args[args.indexOf("--output-schema") + 1]).toBe("/tmp/s.json");
    expect(args.at(-1)).toBe("-");
    expect(args).toContain('model_reasoning_effort="medium"');
  });
});

describe("parseCodexEvents / mapCodexUsage", () => {
  it("takes the LAST agent_message (a premature one is ignored)", () => {
    const stdout = jsonl(
      { type: "thread.started", thread_id: "t" },
      { type: "turn.started" },
      AGENT_MSG("premature — before the tool call"),
      { type: "item.completed", item: { type: "command_execution", command: "ls" } },
      AGENT_MSG("FINAL ANSWER"),
      USAGE({ input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 5 })
    );
    const parsed = parseCodexEvents(stdout);
    expect(parsed.agentMessages.at(-1)).toBe("FINAL ANSWER");
    expect(parsed.usage).toEqual({
      inputTokens: 60, // 100 total - 40 cached
      outputTokens: 25, // 20 + 5 reasoning
      cachedInputTokens: 40,
      cacheWriteInputTokens: 10
    });
  });

  it("omits cacheWriteInputTokens when zero and tolerates malformed lines", () => {
    const usage = mapCodexUsage({ input_tokens: 10, cached_input_tokens: 0, output_tokens: 4 });
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 4, cachedInputTokens: 0 });
    expect("cacheWriteInputTokens" in usage).toBe(false);

    const parsed = parseCodexEvents("not json\n" + jsonl(AGENT_MSG("ok")));
    expect(parsed.agentMessages).toEqual(["ok"]);
  });
});

describe("runCodexExec", () => {
  it("writes the prompt to stdin, closes it, and passes CODEX_HOME through", async () => {
    const { spawner, calls } = makeFakeCodex({ stdout: jsonl(AGENT_MSG("hi"), USAGE({ input_tokens: 5, output_tokens: 1 })) });
    const result = await runCodexExec({
      prompt: "SYSTEM\n\nreview this diff",
      model: "gpt-5.5",
      effort: "low",
      cwd: "/scratch",
      codexHome: "/home/.codex",
      spawn: spawner,
      env: { PATH: "/usr/bin" }
    });
    expect(result.text).toBe("hi");
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("codex");
    expect(calls[0].stdin).toBe("SYSTEM\n\nreview this diff");
    expect(calls[0].stdinClosed).toBe(true);
    expect(calls[0].env.CODEX_HOME).toBe("/home/.codex");
  });

  it("forwards only an allowlisted child env — never provider keys or tokens", async () => {
    const { spawner, calls } = makeFakeCodex({ stdout: jsonl(AGENT_MSG("ok"), USAGE({ input_tokens: 1, output_tokens: 1 })) });
    await runCodexExec({
      prompt: "x",
      model: "gpt-5.5",
      effort: "low",
      cwd: "/s",
      codexHome: "/home/.codex",
      spawn: spawner,
      env: {
        PATH: "/usr/bin",
        HOME: "/home/me",
        LC_ALL: "en_US.UTF-8",
        PROWL_AI_KEY_ANTHROPIC: "sk-secret",
        GITHUB_TOKEN: "ghp_secret",
        SOME_SECRET: "nope",
        SOME_TOKEN: "nope",
        SOME_KEY: "nope"
      }
    });
    const childEnv = calls[0].env;
    expect(childEnv.PATH).toBe("/usr/bin");
    expect(childEnv.HOME).toBe("/home/me");
    expect(childEnv.LC_ALL).toBe("en_US.UTF-8");
    expect(childEnv.CODEX_HOME).toBe("/home/.codex");
    expect(childEnv.PROWL_AI_KEY_ANTHROPIC).toBeUndefined();
    expect(childEnv.GITHUB_TOKEN).toBeUndefined();
    expect(childEnv.SOME_SECRET).toBeUndefined();
    expect(childEnv.SOME_TOKEN).toBeUndefined();
    expect(childEnv.SOME_KEY).toBeUndefined();
  });

  it("honors PROWL_CODEX_BIN for the binary path without forwarding it to the child", async () => {
    const { spawner, calls } = makeFakeCodex({ stdout: jsonl(AGENT_MSG("ok"), USAGE({ input_tokens: 1, output_tokens: 1 })) });
    await runCodexExec({
      prompt: "x",
      model: "gpt-5.5",
      effort: "low",
      cwd: "/s",
      codexHome: "/h",
      spawn: spawner,
      env: { PATH: "/usr/bin", PROWL_CODEX_BIN: "/opt/codex/bin/codex" }
    });
    expect(calls[0].command).toBe("/opt/codex/bin/codex");
    expect(calls[0].env.PROWL_CODEX_BIN).toBeUndefined();
  });

  it("throws an unavailable CodexError when the binary is missing (ENOENT)", async () => {
    const enoent: NodeJS.ErrnoException = Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
    const { spawner } = makeFakeCodex({ spawnError: enoent });
    const error = await runCodexExec({ prompt: "x", model: "gpt-5.5", effort: "low", cwd: "/s", codexHome: "/h", spawn: spawner }).catch((e) => e);
    expect(error).toBeInstanceOf(CodexError);
    expect((error as CodexError).kind).toBe("unavailable");
    expect((error as CodexError).message).toMatch(/codex login/);
  });

  it("classifies an auth failure (no agent_message, auth error event)", async () => {
    const { spawner } = makeFakeCodex({
      stdout: jsonl({ type: "turn.failed", error: { message: "You are not logged in. Run codex login." } })
    });
    const error = await runCodexExec({ prompt: "x", model: "gpt-5.5", effort: "low", cwd: "/s", codexHome: "/h", spawn: spawner }).catch((e) => e);
    expect((error as CodexError).kind).toBe("unauthenticated");
    expect((error as CodexError).message).toMatch(/codex login/);
  });

  it("classifies a subscription usage-limit failure with a reset hint", async () => {
    const { spawner } = makeFakeCodex({
      stdout: jsonl({ type: "error", message: "usage limit reached; resets in 3h 12m" })
    });
    const error = await runCodexExec({ prompt: "x", model: "gpt-5.5", effort: "low", cwd: "/s", codexHome: "/h", spawn: spawner }).catch((e) => e);
    expect((error as CodexError).kind).toBe("usage-limit");
    expect((error as CodexError).message).toMatch(/resets 3h 12m/);
    expect((error as CodexError).message).toMatch(/@prowl-review review/);
  });

  it("throws when a premature agent_message is followed by turn.failed", async () => {
    const { spawner } = makeFakeCodex({
      stdout: jsonl(
        AGENT_MSG("premature happy answer"),
        { type: "turn.failed", error: { message: "the model crashed mid-turn" } }
      )
    });
    const error = await runCodexExec({ prompt: "x", model: "gpt-5.5", effort: "low", cwd: "/s", codexHome: "/h", spawn: spawner }).catch((e) => e);
    expect(error).toBeInstanceOf(CodexError);
    expect((error as CodexError).message).toMatch(/crashed mid-turn/);
  });

  it("throws when an agent_message is present but the exit code is non-zero", async () => {
    const { spawner } = makeFakeCodex({
      stdout: jsonl(AGENT_MSG("answer"), USAGE({ input_tokens: 1, output_tokens: 1 })),
      stderr: "codex: fatal error",
      code: 1
    });
    const error = await runCodexExec({ prompt: "x", model: "gpt-5.5", effort: "low", cwd: "/s", codexHome: "/h", spawn: spawner }).catch((e) => e);
    expect(error).toBeInstanceOf(CodexError);
    expect((error as CodexError).message).toMatch(/fatal error/);
  });

  it("succeeds on agent_message + turn.completed + exit 0", async () => {
    const { spawner } = makeFakeCodex({
      stdout: jsonl(AGENT_MSG("final"), USAGE({ input_tokens: 3, output_tokens: 2 })),
      code: 0
    });
    const result = await runCodexExec({ prompt: "x", model: "gpt-5.5", effort: "low", cwd: "/s", codexHome: "/h", spawn: spawner });
    expect(result.text).toBe("final");
  });

  it("swallows an async stdin EPIPE instead of crashing; the close path reports the failure", async () => {
    const { spawner } = makeFakeCodex({
      stdinError: Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
      stderr: "codex exited early",
      code: 1
    });
    const error = await runCodexExec({
      prompt: "x".repeat(100000),
      model: "gpt-5.5",
      effort: "low",
      cwd: "/s",
      codexHome: "/h",
      spawn: spawner
    }).catch((e) => e);
    // No uncaught exception; a classified error is returned instead.
    expect(error).toBeInstanceOf(CodexError);
    expect((error as CodexError).message).toMatch(/exited early/);
  });

  it("kills the child (SIGTERM then SIGKILL) and fails on the exec timeout", async () => {
    vi.useFakeTimers();
    try {
      const { spawner, calls } = makeFakeCodex({ neverClose: true });
      const promise = runCodexExec({
        prompt: "x",
        model: "gpt-5.5",
        effort: "low",
        cwd: "/s",
        codexHome: "/h",
        spawn: spawner,
        timeoutMs: 1000,
        killGraceMs: 500
      });
      const assertion = expect(promise).rejects.toThrow(/timed out after 1000ms/);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(calls[0].killed).toContain("SIGTERM");
      await vi.advanceTimersByTimeAsync(500);
      expect(calls[0].killed).toContain("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("assertCodexActionSupported", () => {
  it("allows local Codex runs", () => {
    expect(() => assertCodexActionSupported({} as NodeJS.ProcessEnv)).not.toThrow();
  });

  it("rejects GitHub-hosted Actions before spawning Codex", async () => {
    const { spawner, calls } = makeFakeCodex({ stdout: jsonl(AGENT_MSG("unused"), USAGE({ input_tokens: 1 })) });
    const error = await runCodexExec({
      prompt: "x",
      model: "gpt-5.5",
      effort: "low",
      cwd: "/s",
      codexHome: "/h",
      spawn: spawner,
      env: {
        GITHUB_ACTIONS: "true",
        PROWL_RUNNER_ENVIRONMENT: "github-hosted",
        PROWL_REPOSITORY_VISIBILITY: "private"
      }
    }).catch((e) => e);
    expect(error).toBeInstanceOf(CodexError);
    expect((error as CodexError).kind).toBe("unavailable");
    expect((error as Error).message).toMatch(/self-hosted runner/);
    expect(calls).toHaveLength(0);
  });

  it("rejects public repositories even on self-hosted Actions", () => {
    expect(() =>
      assertCodexActionSupported({
        GITHUB_ACTIONS: "true",
        PROWL_RUNNER_ENVIRONMENT: "self-hosted",
        PROWL_REPOSITORY_VISIBILITY: "public"
      } as NodeJS.ProcessEnv)
    ).toThrow(/non-public repository/);
  });

  it("allows self-hosted non-public Actions using event payload visibility", () => {
    const dir = tempDir();
    const eventPath = join(dir, "event.json");
    writeFileSync(eventPath, JSON.stringify({ repository: { visibility: "internal", private: false } }));
    expect(() =>
      assertCodexActionSupported({
        GITHUB_ACTIONS: "true",
        RUNNER_ENVIRONMENT: "self-hosted",
        GITHUB_EVENT_PATH: eventPath
      } as NodeJS.ProcessEnv)
    ).not.toThrow();
  });
});

describe("classifyCodexError", () => {
  it("distinguishes limit, auth, and generic failures", () => {
    expect(classifyCodexError("429 too many requests").kind).toBe("usage-limit");
    expect(classifyCodexError("401 unauthorized").kind).toBe("unauthenticated");
    expect(classifyCodexError("not logged in — run codex login").kind).toBe("unauthenticated");
    expect(classifyCodexError("some other crash").kind).toBe("failed");
    // A generic failure whose text merely contains a path with "login" is NOT auth.
    expect(classifyCodexError("ENOENT: /home/runner/login/cache missing").kind).toBe("failed");
  });
});

describe("composeCodexPrompt", () => {
  it("concatenates system + prompt and adds a JSON-only nudge for json responses", () => {
    const plain = composeCodexPrompt({ system: "SYS", prompt: "DIFF" });
    expect(plain).toBe("SYS\n\nDIFF");
    const json = composeCodexPrompt({ system: "SYS", prompt: "DIFF", responseFormat: "json" });
    expect(json).toMatch(/^SYS\n\nDIFF\n\n/);
    expect(json).toMatch(/only the JSON/i);
  });
});

describe("codex provider registration", () => {
  it("names itself codex and rejects completeWithTools with a pointer to gatherContext", async () => {
    expect(codexProvider.name).toBe("codex");
    const error = await codexProvider
      .completeWithTools({ messages: [], tools: [] }, { provider: "codex", model: "gpt-5.5", apiKey: "" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(CodexError);
    expect((error as CodexError).message).toMatch(/gatherContext/);
  });
});

describe("resolveCodexOptions", () => {
  it("defaults effort to low, the lock on, and 10-min child/lock timeouts", () => {
    const opts = resolveCodexOptions({});
    expect(opts.effort).toBe(DEFAULT_CODEX_EFFORT);
    expect(opts.effort).toBe("low");
    expect(opts.lock).toBe(true);
    expect(opts.timeoutMs).toBe(600_000);
    expect(opts.lockTimeoutMs).toBe(600_000);
    expect(opts.codexHome).toMatch(/\.codex$/);
  });

  it("honors numeric timeout env overrides", () => {
    expect(resolveCodexOptions({ PROWL_CODEX_TIMEOUT_MS: "120000" }).timeoutMs).toBe(120_000);
    expect(resolveCodexOptions({ PROWL_CODEX_LOCK_TIMEOUT_MS: "90000" }).lockTimeoutMs).toBe(90_000);
    // Invalid values fall back to the default.
    expect(resolveCodexOptions({ PROWL_CODEX_TIMEOUT_MS: "-5" }).timeoutMs).toBe(600_000);
    expect(resolveCodexOptions({ PROWL_CODEX_TIMEOUT_MS: "abc" }).timeoutMs).toBe(600_000);
  });

  it("honors env overrides and config defaults (env wins)", () => {
    expect(resolveCodexOptions({ PROWL_CODEX_EFFORT: "high" }).effort).toBe("high");
    expect(resolveCodexOptions({}, { effort: "medium" }).effort).toBe("medium");
    expect(resolveCodexOptions({ PROWL_CODEX_EFFORT: "high" }, { effort: "medium" }).effort).toBe("high");
    expect(resolveCodexOptions({ PROWL_CODEX_LOCK: "false" }).lock).toBe(false);
    expect(resolveCodexOptions({}, { lock: false }).lock).toBe(false);
    // xhigh is valid; minimal is no longer offered for these models → falls back.
    expect(resolveCodexOptions({ PROWL_CODEX_EFFORT: "xhigh" }).effort).toBe("xhigh");
    expect(resolveCodexOptions({ PROWL_CODEX_EFFORT: "minimal" }).effort).toBe("low");
    // Unknown effort falls back to the default.
    expect(resolveCodexOptions({ PROWL_CODEX_EFFORT: "bogus" }).effort).toBe("low");
    // CODEX_HOME override is respected.
    expect(resolveCodexOptions({ CODEX_HOME: "/custom/codex" }).codexHome).toBe("/custom/codex");
  });
});

describe("codex cost + failback", () => {
  it("reports $0.00 with the ChatGPT subscription label while keeping token counts", () => {
    const cost = estimateCost(
      { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 400 },
      "codex",
      "gpt-5.5"
    );
    expect(cost.usd).toBe(0);
    const line = formatCostLine(cost);
    expect(line).toContain("$0.00 (ChatGPT subscription)");
    expect(line).toContain("codex/gpt-5.5");
    expect(line).toContain("in 1,000");
  });

  it("fails back gpt-5.6-terra -> gpt-5.5 (and never through retired gpt-5.4)", () => {
    expect(modelFailbackChain("codex", "gpt-5.6-terra")).toEqual(["gpt-5.5"]);
    expect(modelFailbackChain("codex", "gpt-5.5")).toEqual([]);
  });
});

describe("keyless codex config", () => {
  it("resolveProviderConfig accepts codex with no PROWL_AI_KEY and stays redactable", () => {
    const config = resolveProviderConfig({ PROWL_AI_PROVIDER: "codex" }, {});
    expect(config.provider).toBe("codex");
    expect(config.model).toBe("gpt-5.5");
    expect(config.apiKey).toBe("");
    expect(config.codex?.effort).toBe("low");
    // Redaction hooks still installed.
    expect(JSON.parse(JSON.stringify(config))).toEqual({ provider: "codex", model: "gpt-5.5", apiKey: "<redacted>" });
  });

  it("ensemble resolution includes codex without a key alongside an API-key provider", () => {
    const { configs, notes } = resolveEnsembleConfigs({
      primary: { provider: "anthropic", model: "claude-haiku-4-5", apiKey: "sk-a" },
      providers: [
        { provider: "anthropic" },
        { provider: "codex" }
      ],
      env: { PROWL_AI_KEY_ANTHROPIC: "sk-a" }
    });
    const providers = configs.map((c) => c.provider);
    expect(providers).toContain("codex");
    expect(providers).toContain("anthropic");
    const codex = configs.find((c) => c.provider === "codex");
    expect(codex?.apiKey).toBe("");
    // Codex is never skipped for lacking a key.
    expect(notes.join(" ")).not.toMatch(/skipped "codex"/);
  });
});
