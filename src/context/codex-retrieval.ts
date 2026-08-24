import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readRepoFile } from "./tools.js";
import { isSensitiveFile, redactSecrets } from "../review/redact.js";
import {
  codexLockConfig,
  resolveCodexOptions,
  runCodexExec,
  DEFAULT_CODEX_EFFORT,
  type CodexSpawner
} from "../providers/codex.js";
import { resolveCodexHome, withCodexLock } from "../providers/codex-lock.js";
import type { GatherContextParams, GatheredContext, RetrievedFile } from "./retrieval.js";
import { ContextRetrievalError } from "./retrieval.js";
import { emptyUsage, type TokenUsage } from "../providers/index.js";
import { totalTokens } from "../cost/pricing.js";

/**
 * Agentic cross-file retrieval for the `codex` provider (backlog #45).
 *
 * Codex runs its own tool loop, so it has no `completeWithTools` mapping. Instead
 * this runs ONE `codex exec --sandbox read-only -C <repo>` that returns a bundle
 * of repo-relative paths (+ a reason each) via a strict `--output-schema`. Codex's
 * shell bypasses the `tools.ts` confinement, so its output is treated as
 * **untrusted**: every returned path is re-read through the sandboxed
 * {@link readRepoFile} (root confinement, symlink rejection, ignore rules, byte
 * caps) and run through {@link redactSecrets}; sensitive/escaping/missing paths
 * are dropped with a note. `maxFiles` and the token budget are honored and any
 * truncation is reported (core principle #5 — no silent truncation).
 */

/** One entry Codex returns in the retrieval bundle. */
interface CodexBundleEntry {
  path: string;
  reason: string;
}

/** Strict JSON schema (OpenAI json_schema mode) for the retrieval bundle. */
export const CODEX_RETRIEVAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["files"],
  properties: {
    files: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "reason"],
        properties: {
          path: { type: "string" },
          reason: { type: "string" }
        }
      }
    }
  }
} as const;

/** Build the retrieval instruction prompt for Codex. */
export function buildCodexRetrievalPrompt(changedPaths: string[], system?: string): string {
  const parts: string[] = [];
  if (system) {
    parts.push(system);
  }
  parts.push(
    [
      "You are gathering cross-file context to review a pull request in this repository.",
      "",
      "Changed files:",
      ...changedPaths.map((p) => `- ${p}`),
      "",
      "Explore the repository (read-only) and identify the existing files whose content a",
      "reviewer needs to catch broken callers, contract/interface violations, and inconsistent",
      "patterns — the definitions and call sites of the changed code plus closely related files.",
      "Return ONLY repo-relative paths of files that already exist, each with a short reason.",
      "Do not include the changed files themselves unless a reviewer must re-read them for context.",
      "Prefer a focused set over an exhaustive one."
    ].join("\n")
  );
  return parts.join("\n\n");
}

/** Parse Codex's final message into a validated list of bundle entries. */
export function parseCodexRetrievalBundle(text: string): CodexBundleEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const files = (parsed as { files?: unknown })?.files;
  if (!Array.isArray(files)) {
    return [];
  }
  const entries: CodexBundleEntry[] = [];
  for (const raw of files) {
    const path = (raw as { path?: unknown })?.path;
    const reason = (raw as { reason?: unknown })?.reason;
    if (typeof path === "string" && path.trim().length > 0) {
      entries.push({ path: path.trim(), reason: typeof reason === "string" ? reason : "" });
    }
  }
  return entries;
}

/**
 * Gather cross-file context for `codex` by spawning `codex exec` once and re-reading
 * the returned paths through the sandboxed toolkit + redaction.
 */
export async function gatherCodexContext(
  params: GatherContextParams & { spawn?: CodexSpawner; env?: NodeJS.ProcessEnv }
): Promise<GatheredContext> {
  const env = params.env ?? process.env;
  const codex = params.config?.codex ?? resolveCodexOptions(env);
  const codexHome = codex.codexHome ?? resolveCodexHome(env);
  const model = params.config?.model ?? "gpt-5.5";
  const maxFiles = params.limits?.maxFiles ?? 20;
  const maxTokens = params.limits?.maxTokens;
  const notes: string[] = [];

  const prompt = buildCodexRetrievalPrompt(params.changedPaths, params.system);

  let usage: TokenUsage = emptyUsage();
  let bundle: CodexBundleEntry[];
  try {
    const result = await withCodexLock(codexLockConfig(codex), async () => {
      const schemaDir = mkdtempSync(join(tmpdir(), "prowl-codex-ctx-"));
      const schemaPath = join(schemaDir, "schema.json");
      writeFileSync(schemaPath, JSON.stringify(CODEX_RETRIEVAL_SCHEMA));
      try {
        return await runCodexExec({
          prompt,
          model,
          effort: codex.effort ?? DEFAULT_CODEX_EFFORT,
          // Codex needs the real repo root to explore (read-only sandbox).
          cwd: params.toolkit.root,
          codexHome,
          schemaPath,
          ...(params.spawn ? { spawn: params.spawn } : {}),
          env
        });
      } finally {
        rmSync(schemaDir, { recursive: true, force: true });
      }
    });
    usage = result.usage;
    bundle = parseCodexRetrievalBundle(result.text);
    if (bundle.length === 0) {
      notes.push("Codex returned no usable retrieval bundle; reviewing with the diff only.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ContextRetrievalError(message, { usage, rounds: 1, notes });
  }

  const files = new Map<string, RetrievedFile>();
  let reachedLimit = false;

  for (const entry of bundle) {
    if (files.size >= maxFiles) {
      notes.push(`File budget reached (${maxFiles}); skipped ${bundle.length - files.size} more Codex-suggested file(s).`);
      reachedLimit = true;
      break;
    }
    // Untrusted path: refuse sensitive files, then re-read through the sandboxed
    // toolkit so root confinement / symlink rejection / ignore rules / caps apply.
    if (isSensitiveFile(entry.path)) {
      notes.push(`Refused Codex-suggested sensitive file ${entry.path} (kept out of context).`);
      continue;
    }
    try {
      const read = readRepoFile(params.toolkit, entry.path);
      if (files.has(read.path)) {
        continue;
      }
      const { text: safeContent, count: redactions } = redactSecrets(read.content);
      if (redactions > 0) {
        notes.push(`Redacted ${redactions} secret(s) from ${read.path}.`);
      }
      if (read.truncated) {
        notes.push(`Truncated ${read.path} to ${read.bytes} bytes.`);
        reachedLimit = true;
      }
      files.set(read.path, { path: read.path, content: safeContent, truncated: read.truncated });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notes.push(`Skipped Codex-suggested path ${entry.path}: ${message}.`);
    }
  }

  if (maxTokens !== undefined && totalTokens(usage) >= maxTokens) {
    notes.push(`Reached context token budget (${maxTokens}).`);
    reachedLimit = true;
  }

  return {
    files: [...files.values()],
    toolOutputs: [],
    rounds: 1,
    usage,
    reachedLimit,
    notes
  };
}
