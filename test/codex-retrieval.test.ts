import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildCodexRetrievalPrompt,
  gatherCodexContext,
  parseCodexRetrievalBundle,
  CODEX_RETRIEVAL_SCHEMA
} from "../src/context/codex-retrieval.js";
import type { CodexProcess, CodexSpawner } from "../src/providers/codex.js";
import type { ProviderConfig } from "../src/providers/index.js";

function jsonl(...events: unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

/** Spawn stub replaying a single agent_message (the retrieval bundle JSON) + usage. */
function fakeCodex(bundleJson: string, usage: Record<string, number> = { input_tokens: 50, output_tokens: 10 }): CodexSpawner {
  const stdout = jsonl(
    { type: "item.completed", item: { type: "agent_message", text: bundleJson } },
    { type: "turn.completed", usage }
  );
  return () => {
    const out = new EventEmitter();
    const child = new EventEmitter();
    const fake: CodexProcess = {
      stdin: {
        write: () => true,
        end: () => {
          setImmediate(() => {
            out.emit("data", Buffer.from(stdout));
            child.emit("close", 0);
          });
        },
        on: () => undefined
      } as CodexProcess["stdin"],
      stdout: { on: (event: string, cb: (chunk: Buffer) => void) => out.on(event, cb) } as CodexProcess["stdout"],
      stderr: { on: () => undefined } as CodexProcess["stderr"],
      on: (event: "error" | "close", cb: (arg: never) => void) => {
        child.on(event, cb as (arg: unknown) => void);
      },
      kill: () => undefined
    };
    return fake;
  };
}

function neverClosingCodex(): CodexSpawner {
  return () => {
    const child = new EventEmitter();
    const fake: CodexProcess = {
      stdin: {
        write: () => true,
        end: () => undefined,
        on: () => undefined
      } as CodexProcess["stdin"],
      stdout: { on: () => undefined } as CodexProcess["stdout"],
      stderr: { on: () => undefined } as CodexProcess["stderr"],
      on: (event: "error" | "close", cb: (arg: never) => void) => {
        child.on(event, cb as (arg: unknown) => void);
      },
      kill: (signal?: NodeJS.Signals | number) => {
        if (signal === "SIGKILL") {
          setImmediate(() => child.emit("close", null));
        }
      }
    };
    return fake;
  };
}

const CODEX_CONFIG: ProviderConfig = {
  provider: "codex",
  model: "gpt-5.5",
  apiKey: "",
  codex: { effort: "low", lock: false, codexHome: "/tmp/does-not-matter" }
};

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "prowl-codex-repo-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export const A = 1;\nconst apiKey = \"AKIA1234567890ABCDEF\";\n");
  writeFileSync(join(repo, "src", "b.ts"), "export const B = 2;\n");
  writeFileSync(join(repo, ".env"), "SECRET_TOKEN=supersecretvalue123\n");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("CODEX_RETRIEVAL_SCHEMA", () => {
  it("is strict json_schema (additionalProperties:false all the way down)", () => {
    expect(CODEX_RETRIEVAL_SCHEMA.additionalProperties).toBe(false);
    expect(CODEX_RETRIEVAL_SCHEMA.properties.files.items.additionalProperties).toBe(false);
    expect(CODEX_RETRIEVAL_SCHEMA.required).toEqual(["files"]);
    expect(CODEX_RETRIEVAL_SCHEMA.properties.files.items.required).toEqual(["path", "reason"]);
  });
});

describe("parseCodexRetrievalBundle", () => {
  it("extracts valid path entries and tolerates junk", () => {
    expect(parseCodexRetrievalBundle('{"files":[{"path":"src/a.ts","reason":"caller"}]}')).toEqual([
      { path: "src/a.ts", reason: "caller" }
    ]);
    expect(parseCodexRetrievalBundle("not json")).toEqual([]);
    expect(parseCodexRetrievalBundle('{"files":"nope"}')).toEqual([]);
    expect(parseCodexRetrievalBundle('{"files":[{"reason":"no path"},{"path":"  "}]}')).toEqual([]);
  });
});

describe("buildCodexRetrievalPrompt", () => {
  it("lists the changed files and prepends system guidance", () => {
    const prompt = buildCodexRetrievalPrompt(["src/a.ts", "src/b.ts"], "REVIEW GUIDELINES");
    expect(prompt).toMatch(/REVIEW GUIDELINES/);
    expect(prompt).toMatch(/- src\/a\.ts/);
    expect(prompt).toMatch(/- src\/b\.ts/);
    expect(prompt).toMatch(/repo-relative paths/);
    // Soft guard: instruct Codex not to open secret-bearing files.
    expect(prompt).toMatch(/\.env/);
    expect(prompt).toMatch(/private keys|credential|secrets/i);
  });
});

describe("gatherCodexContext", () => {
  it("re-reads suggested paths through the sandboxed toolkit with redaction, refusing sensitive/escaping paths", async () => {
    const bundle = JSON.stringify({
      files: [
        { path: "src/a.ts", reason: "defines A" },
        { path: ".env", reason: "config" },
        { path: "../../etc/passwd", reason: "escape attempt" },
        { path: "src/missing.ts", reason: "does not exist" }
      ]
    });
    const gathered = await gatherCodexContext({
      toolkit: { root: repo },
      changedPaths: ["src/b.ts"],
      config: CODEX_CONFIG,
      spawn: fakeCodex(bundle),
      env: { CODEX_HOME: "/tmp/x" }
    });

    const paths = gathered.files.map((file) => file.path);
    expect(paths).toContain("src/a.ts");
    // Sensitive, escaping, and missing paths never make it into the bundle.
    expect(paths).not.toContain(".env");
    expect(paths.some((p) => p.includes("passwd"))).toBe(false);
    expect(paths).not.toContain("src/missing.ts");

    // The secret inside src/a.ts is redacted, never passed through raw.
    const a = gathered.files.find((file) => file.path === "src/a.ts");
    expect(a?.content).toMatch(/\[REDACTED:/);
    expect(a?.content).not.toContain("AKIA1234567890ABCDEF");

    // Untrusted refusals/skips are surfaced, never silent (#5).
    expect(gathered.notes.some((n) => /sensitive file \.env/i.test(n))).toBe(true);
    expect(gathered.notes.some((n) => /passwd/.test(n))).toBe(true);
    expect(gathered.notes.some((n) => /Redacted \d+ secret/.test(n))).toBe(true);
    expect(gathered.usage.inputTokens).toBe(50);
    expect(gathered.rounds).toBe(1);
  });

  it("honors maxFiles and reports the truncation", async () => {
    const bundle = JSON.stringify({
      files: [
        { path: "src/a.ts", reason: "one" },
        { path: "src/b.ts", reason: "two" }
      ]
    });
    const gathered = await gatherCodexContext({
      toolkit: { root: repo },
      changedPaths: ["src/x.ts"],
      config: CODEX_CONFIG,
      limits: { maxFiles: 1 },
      spawn: fakeCodex(bundle),
      env: { CODEX_HOME: "/tmp/x" }
    });
    expect(gathered.files).toHaveLength(1);
    expect(gathered.reachedLimit).toBe(true);
    expect(gathered.notes.some((n) => /File budget reached \(1\)/.test(n))).toBe(true);
  });

  it("reports the context token budget when usage meets it", async () => {
    const bundle = JSON.stringify({ files: [{ path: "src/b.ts", reason: "one" }] });
    const gathered = await gatherCodexContext({
      toolkit: { root: repo },
      changedPaths: ["src/x.ts"],
      config: CODEX_CONFIG,
      limits: { maxTokens: 10 },
      spawn: fakeCodex(bundle, { input_tokens: 50, output_tokens: 10 }),
      env: { CODEX_HOME: "/tmp/x" }
    });
    expect(gathered.reachedLimit).toBe(true);
    expect(gathered.notes.some((n) => /Reached context token budget \(10\)/.test(n))).toBe(true);
  });

  it("passes resolved Codex timeouts to the retrieval exec", async () => {
    vi.useFakeTimers();
    try {
      const promise = gatherCodexContext({
        toolkit: { root: repo },
        changedPaths: ["src/x.ts"],
        config: {
          ...CODEX_CONFIG,
          codex: { ...CODEX_CONFIG.codex, timeoutMs: 100 }
        },
        spawn: neverClosingCodex(),
        env: { CODEX_HOME: "/tmp/x" }
      });
      const assertion = expect(promise).rejects.toThrow(/timed out after 100ms/);
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("notes an empty bundle instead of failing", async () => {
    const gathered = await gatherCodexContext({
      toolkit: { root: repo },
      changedPaths: ["src/x.ts"],
      config: CODEX_CONFIG,
      spawn: fakeCodex('{"files":[]}'),
      env: { CODEX_HOME: "/tmp/x" }
    });
    expect(gathered.files).toHaveLength(0);
    expect(gathered.notes.some((n) => /no usable retrieval bundle/i.test(n))).toBe(true);
  });
});
