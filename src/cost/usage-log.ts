import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ProviderName } from "../providers/index.js";
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

/** Append one record as a JSON line, creating the directory if needed. */
export function appendUsageRecord(path: string, record: UsageRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

/** Read + parse usage records, skipping blank/malformed lines (never throws on bad data). */
export function readUsageRecords(path: string): UsageRecord[] {
  if (!existsSync(path)) {
    return [];
  }
  const records: UsageRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as Partial<UsageRecord>;
      if (
        typeof parsed.provider === "string" &&
        typeof parsed.model === "string" &&
        typeof parsed.inputTokens === "number"
      ) {
        records.push(parsed as UsageRecord);
      }
    } catch {
      // skip a malformed line rather than sinking the whole read
    }
  }
  return records;
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

/** Aggregate usage records into totals + a per provider/model breakdown. */
export function aggregateUsage(records: UsageRecord[]): UsageAggregate {
  const groups = new Map<string, UsageGroup>();
  const total = { runs: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, usd: 0, priced: true };
  let since: string | undefined;
  let until: string | undefined;

  for (const record of records) {
    total.runs += 1;
    total.inputTokens += record.inputTokens;
    total.outputTokens += record.outputTokens;
    total.cachedInputTokens += record.cachedInputTokens;
    total.usd += record.usd ?? 0;
    if (record.usd === null) {
      total.priced = false;
    }
    if (typeof record.ts === "string") {
      if (since === undefined || record.ts < since) {
        since = record.ts;
      }
      if (until === undefined || record.ts > until) {
        until = record.ts;
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
