import { constants, mkdirSync } from "node:fs";
import { appendFile, open } from "node:fs/promises";
import { dirname } from "node:path";
import { prepareDebugLogPathForWrite } from "./paths.js";
import { redactSecrets } from "../review/redact.js";
import type { Finding } from "../review/findings.js";

/**
 * Debug/verbose run tracing (backlog #49).
 *
 * A maintainer tuning the reviewer needs to see what a run actually did: the
 * prompts it assembled, the files context retrieval pulled, the findings at each
 * stage (raw → verified → judged), and the token/cost breakdown. This module is
 * the seam: the pipeline, the multi-pass review, and the CLI emit structured
 * {@link DebugEvent}s to an injected {@link DebugSink}; the CLI's sink appends
 * them to a line-per-event JSONL file in order, without blocking review work on
 * per-event disk I/O.
 *
 * Secrets never leak (#15): every string field of every event is run through
 * {@link redactSecrets} at the sink boundary, so emitters can stay oblivious.
 */

/** A finding flattened for tracing — the fields a maintainer needs, not the full object. */
export interface DebugFinding {
  file?: string;
  line?: number;
  severity: string;
  category?: string;
  confidence: number;
  title: string;
  /** Providers that raised it, for ensemble provenance (#53). */
  sources?: string[];
}

/** Structured trace events emitted across a review run (#49). */
export type DebugEvent =
  | {
      type: "run-start";
      pr: string;
      provider: string;
      model: string;
      /** Provider names when an ensemble runs (#53); omitted for a single-provider review. */
      ensemble?: string[];
      dryRun: boolean;
      incremental: boolean;
    }
  | { type: "diff"; reviewedFiles: number; skippedFiles: number; incrementalBase?: string }
  | {
      type: "context";
      files: { path: string; truncated: boolean }[];
      rounds: number;
      reachedLimit: boolean;
    }
  | { type: "grounding"; findings: number; notes: number }
  | { type: "prompt"; provider: string; model: string; pass: string; system: string; prompt: string }
  | {
      type: "pass";
      provider: string;
      model: string;
      pass: string;
      ok: boolean;
      retried: boolean;
      findings: DebugFinding[];
    }
  | { type: "raw-findings"; provider: string; findings: DebugFinding[] }
  | {
      type: "verification";
      provider: string;
      verified: number;
      droppedFalsePositive: number;
      demoted: number;
      unverified: number;
      ok: boolean;
      findings: DebugFinding[];
    }
  | {
      type: "judge";
      provider: string;
      duplicatesRemoved: number;
      belowThreshold: number;
      belowConfidence: number;
      capped: number;
      findings: DebugFinding[];
    }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      cacheWriteInputTokens: number;
    }
  | { type: "cost"; estimates: { provider: string; model: string; usd: number | null; totalTokens: number }[] }
  | { type: "run-end"; findings: number; posted: boolean };

/** Receives trace events. Synchronous and tolerant — emitting never throws into the caller. */
export type DebugSink = (event: DebugEvent) => void;

/** A stamped, redacted trace record: one JSONL line. `seq` orders emission, `t` is ms since the sink was created. */
export interface DebugRecord {
  seq: number;
  t: number;
  event: DebugEvent;
}

/** Flatten findings to the trace shape (#49); drops bodies/suggestions to keep the log compact. */
export function toDebugFindings(findings: readonly Finding[]): DebugFinding[] {
  return findings.map((finding) => ({
    ...(finding.file !== undefined ? { file: finding.file } : {}),
    ...(finding.line !== undefined ? { line: finding.line } : {}),
    severity: finding.severity,
    ...(finding.category !== undefined ? { category: finding.category } : {}),
    confidence: finding.confidence,
    title: finding.title,
    ...(finding.sources !== undefined ? { sources: finding.sources } : {})
  }));
}

/** JSON serializer hook: redact only string leaves while JSON.stringify traverses the record. */
function redactJsonString(_key: string, value: unknown): unknown {
  if (typeof value === "string") {
    return redactSecrets(value).text;
  }
  return value;
}

/** Serialize a debug record as redacted JSON without a separate deep-copy walk. */
function stringifyDebugRecord(record: DebugRecord): string {
  const json = JSON.stringify(record, redactJsonString);
  if (json === undefined) {
    throw new Error("Debug record was not JSON serializable.");
  }
  return json;
}

/** Redact a record for in-memory consumers while preserving the public DebugRecord shape. */
function redactRecord(record: DebugRecord): DebugRecord {
  return JSON.parse(stringifyDebugRecord(record)) as DebugRecord;
}

/** Stamp a debug event with monotonic sequence and elapsed milliseconds. */
function createDebugRecord(
  event: DebugEvent,
  state: { seq: number; start: number },
  now: () => number
): DebugRecord {
  return {
    seq: state.seq++,
    t: Math.max(0, Math.round(now() - state.start)),
    event
  };
}

/**
 * Build a {@link DebugSink} that stamps each event with a sequence number and a
 * relative timestamp, redacts it, and hands the record to `write`. A `write`
 * failure is swallowed — tracing must never sink the review. `now` is injectable
 * for deterministic tests.
 */
export function createDebugSink(
  write: (record: DebugRecord) => void,
  options: { now?: () => number } = {}
): DebugSink {
  const now = options.now ?? (() => Date.now());
  const state = { seq: 0, start: now() };
  return (event: DebugEvent) => {
    try {
      write(redactRecord(createDebugRecord(event, state, now)));
    } catch {
      // tracing is best-effort; never throw into the review
    }
  };
}

/**
 * In-memory sink for tests/programmatic use: returns the sink plus the array it
 * appends redacted, stamped records to.
 */
export function createDebugRecorder(options: { now?: () => number } = {}): {
  sink: DebugSink;
  records: DebugRecord[];
} {
  const records: DebugRecord[] = [];
  const sink = createDebugSink((record) => records.push(record), options);
  return { sink, records };
}

/**
 * Append one JSONL line. When a workspace is provided, validate confinement and
 * symlink components immediately before the write; `O_NOFOLLOW` protects the
 * final file, and platforms without it fail closed.
 */
async function appendJsonlLine(path: string, line: string, workspace?: string): Promise<void> {
  if (!workspace) {
    await appendFile(path, line);
    return;
  }

  const resolvedPath = prepareDebugLogPathForWrite(path, workspace);
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("Debug trace writes require O_NOFOLLOW support.");
  }
  const handle = await open(
    resolvedPath,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await handle.writeFile(line);
  } finally {
    await handle.close();
  }
}

/**
 * File sink: append each event as one JSON line (#49). Writes are queued in
 * order with async filesystem calls so debug tracing does not block the review
 * hot path on per-event disk I/O. Parent directories are created best-effort for
 * explicit nested paths such as `traces/run.jsonl`.
 */
export function createJsonlSink(path: string, options: { now?: () => number; workspace?: string } = {}): DebugSink {
  const now = options.now ?? (() => Date.now());
  const state = { seq: 0, start: now() };
  let pending: Promise<void> = Promise.resolve();

  if (!options.workspace) {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      // write failures are swallowed below; directory creation is best-effort too
    }
  }

  return (event: DebugEvent) => {
    let line: string;
    try {
      line = `${stringifyDebugRecord(createDebugRecord(event, state, now))}\n`;
    } catch {
      return;
    }
    pending = pending.then(() => appendJsonlLine(path, line, options.workspace)).catch(() => {});
    void pending;
  };
}
