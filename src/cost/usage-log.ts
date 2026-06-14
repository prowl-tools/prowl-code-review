import { appendFileSync, createReadStream, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { PROVIDER_NAMES, type ProviderName } from "../providers/index.js";
import type { CostEstimate } from "./pricing.js";

/**
 * Local usage log (backlog #36).
 *
 * Per-review cost is appended as one JSON object per line to
 * `.prowl-review/usage.jsonl` so the `prowl-review costs` command can aggregate
 * local/pre-push runs offline. CI runs are ephemeral, so they emit per-run cost
 * to logs + the Action job summary instead (the provider dashboard is the source
 * of truth for the real bill). One bad line never sinks a read.
 */

/** Directory + filename for the local usage log, relative to a workspace root. */
export const USAGE_LOG_DIR = ".prowl-review";
export const USAGE_LOG_FILENAME = "usage.jsonl";

/** One appended usage record. */
export interface UsageRecord {
  /** ISO-8601 timestamp. */
  ts: string;
  provider: ProviderName;
  model: string;
  /** `owner/repo`, when known. */
  repo?: string;
  /** Pull request number, when known. */
  pr?: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Estimated USD, or null when the model had no known price. */
  usd: number | null;
}

/** Default usage-log path under a workspace root. */
export function defaultUsageLogPath(workspace: string): string {
  return join(resolve(workspace), USAGE_LOG_DIR, USAGE_LOG_FILENAME);
}

/** Search `startDir` and ancestors for an existing usage log; return its path or null. */
export function findUsageLog(startDir: string): string | null {
  let current = resolve(startDir);
  for (;;) {
    const candidate = join(current, USAGE_LOG_DIR, USAGE_LOG_FILENAME);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/** Build a usage record from a cost estimate (+ optional repo/PR identity). */
export function toUsageRecord(
  estimate: CostEstimate,
  meta: { ts: string; repo?: string; pr?: number }
): UsageRecord {
  return {
    ts: meta.ts,
    provider: estimate.provider,
    model: estimate.model,
    repo: meta.repo,
    pr: meta.pr,
    inputTokens: estimate.inputTokens,
    outputTokens: estimate.outputTokens,
    cachedInputTokens: estimate.cachedInputTokens,
    usd: estimate.usd
  };
}

/** Reject symlinked log directories/files so usage appends cannot escape the workspace. */
function assertNotSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`Usage log path must not be a symlink: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}

/** Append one record as a JSON line, creating the directory if needed. */
export function appendUsageRecord(path: string, record: UsageRecord): void {
  const dir = dirname(path);
  assertNotSymlink(dir);
  assertNotSymlink(path);
  mkdirSync(dir, { recursive: true });
  assertNotSymlink(dir);
  assertNotSymlink(path);
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

/** True when a decoded JSON value is a finite number. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Runtime guard for provider names persisted in usage logs. */
function isProviderName(value: unknown): value is ProviderName {
  return typeof value === "string" && (PROVIDER_NAMES as readonly string[]).includes(value);
}

/** Runtime guard for complete usage records before aggregation. */
function isUsageRecord(value: unknown): value is UsageRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<UsageRecord>;
  return (
    typeof record.ts === "string" &&
    isProviderName(record.provider) &&
    typeof record.model === "string" &&
    record.model.length > 0 &&
    isFiniteNumber(record.inputTokens) &&
    isFiniteNumber(record.outputTokens) &&
    isFiniteNumber(record.cachedInputTokens) &&
    (record.usd === null || isFiniteNumber(record.usd)) &&
    (record.repo === undefined || typeof record.repo === "string") &&
    (record.pr === undefined || isFiniteNumber(record.pr))
  );
}

/** Stream usage records, skipping blank/malformed lines (never throws on bad data). */
export async function* readUsageRecords(path: string): AsyncGenerator<UsageRecord> {
  if (!existsSync(path)) {
    return;
  }
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity
  });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isUsageRecord(parsed)) {
        yield parsed;
      }
    } catch {
      // skip a malformed line rather than sinking the whole read
    }
  }
}

/** Per-provider/model aggregate of usage records. */
export interface UsageGroup {
  key: string;
  provider: ProviderName;
  model: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  usd: number;
  /** True when every run in the group had a known price (so `usd` is complete). */
  priced: boolean;
}

export interface UsageAggregate {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  usd: number;
  /** True when every run had a known price (so `usd` is complete). */
  priced: boolean;
  /** Per provider/model breakdown, most-expensive first. */
  groups: UsageGroup[];
  /** Earliest / latest record timestamps, when any records exist. */
  since?: string;
  until?: string;
}

interface UsageAggregateState {
  groups: Map<string, UsageGroup>;
  total: {
    runs: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    usd: number;
    priced: boolean;
  };
  since?: string;
  sinceMs?: number;
  until?: string;
  untilMs?: number;
}

/** Create mutable aggregation state shared by the sync and async reducers. */
function createAggregateState(): UsageAggregateState {
  return {
    groups: new Map<string, UsageGroup>(),
    total: { runs: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, usd: 0, priced: true }
  };
}

/** Fold one usage record into the aggregate state. */
function addRecordToAggregate(state: UsageAggregateState, record: UsageRecord): void {
  const { total, groups } = state;
  total.runs += 1;
  total.inputTokens += record.inputTokens;
  total.outputTokens += record.outputTokens;
  total.cachedInputTokens += record.cachedInputTokens;
  total.usd += record.usd ?? 0;
  if (record.usd === null) {
    total.priced = false;
  }
  const tsMs = Date.parse(record.ts);
  if (Number.isFinite(tsMs)) {
    if (state.sinceMs === undefined || tsMs < state.sinceMs) {
      state.sinceMs = tsMs;
      state.since = record.ts;
    }
    if (state.untilMs === undefined || tsMs > state.untilMs) {
      state.untilMs = tsMs;
      state.until = record.ts;
    }
  }

  const key = `${record.provider}/${record.model}`;
  const group = groups.get(key) ?? {
    key,
    provider: record.provider,
    model: record.model,
    runs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    usd: 0,
    priced: true
  };
  group.runs += 1;
  group.inputTokens += record.inputTokens;
  group.outputTokens += record.outputTokens;
  group.cachedInputTokens += record.cachedInputTokens;
  group.usd += record.usd ?? 0;
  if (record.usd === null) {
    group.priced = false;
  }
  groups.set(key, group);
}

/** Convert mutable aggregate state into the public result shape. */
function finishAggregate(state: UsageAggregateState): UsageAggregate {
  const { total, groups, since, until } = state;
  return {
    runs: total.runs,
    inputTokens: total.inputTokens,
    outputTokens: total.outputTokens,
    cachedInputTokens: total.cachedInputTokens,
    totalTokens: total.inputTokens + total.outputTokens + total.cachedInputTokens,
    usd: total.usd,
    priced: total.priced,
    groups: [...groups.values()].sort((a, b) => b.usd - a.usd),
    since,
    until
  };
}

/** Aggregate usage records into totals + a per provider/model breakdown. */
export function aggregateUsage(records: Iterable<UsageRecord>): UsageAggregate {
  const state = createAggregateState();
  for (const record of records) {
    addRecordToAggregate(state, record);
  }
  return finishAggregate(state);
}

/** Aggregate streamed usage records without buffering the full log. */
export async function aggregateUsageAsync(records: AsyncIterable<UsageRecord>): Promise<UsageAggregate> {
  const state = createAggregateState();
  for await (const record of records) {
    addRecordToAggregate(state, record);
  }
  return finishAggregate(state);
}
