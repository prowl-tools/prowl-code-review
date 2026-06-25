import { appendFileSync } from "node:fs";
import { redactSecrets } from "../review/redact.js";
import type { Finding } from "../review/findings.js";

/**
 * Debug/verbose run tracing (backlog #49).
 *
 * A maintainer tuning the reviewer needs to see what a run actually did: the
 * prompts it assembled, the files context retrieval pulled, the findings at each
 * stage (raw → verified → judged), and the token/cost breakdown. This module is
 * the seam: the pipeline, the multi-pass review, and the CLI emit structured
 * {@link DebugEvent}s to an injected {@link DebugSink}; the CLI's sink streams
 * them to a line-per-event JSONL file so a run that exits early is still
 * readable.
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

/** Recursively redact secrets from every string in a JSON-ish value (#15 defense-in-depth). */
function redactDeep<T>(value: T): T {
  if (typeof value === "string") {
    return redactSecrets(value).text as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactDeep(item);
    }
    return out as T;
  }
  return value;
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
  const start = now();
  let seq = 0;
  return (event: DebugEvent) => {
    const record: DebugRecord = {
      seq: seq++,
      t: Math.max(0, Math.round(now() - start)),
      event: redactDeep(event)
    };
    try {
      write(record);
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
 * File sink: append each event as one JSON line (#49). `appendFileSync` flushes
 * per line, so a run that exits mid-review still leaves a readable, parseable
 * trace up to the last completed event.
 */
export function createJsonlSink(path: string, options: { now?: () => number } = {}): DebugSink {
  return createDebugSink((record) => {
    appendFileSync(path, `${JSON.stringify(record)}\n`);
  }, options);
}
