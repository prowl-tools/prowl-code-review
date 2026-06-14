import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendUsageRecord,
  readUsageRecords,
  aggregateUsage,
  toUsageRecord,
  defaultUsageLogPath,
  findUsageLog,
  USAGE_LOG_DIR,
  USAGE_LOG_FILENAME,
  type UsageRecord
} from "../src/cost/usage-log.js";
import type { CostEstimate } from "../src/cost/pricing.js";

let tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "prowl-usage-"));
  tempDirs.push(dir);
  return dir;
}

function record(over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    ts: "2026-06-14T00:00:00.000Z",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    inputTokens: 100,
    outputTokens: 50,
    cachedInputTokens: 10,
    usd: 0.01,
    ...over
  };
}

async function collect(records: AsyncIterable<UsageRecord>): Promise<UsageRecord[]> {
  const out: UsageRecord[] = [];
  for await (const record of records) {
    out.push(record);
  }
  return out;
}

describe("usage log round-trip", () => {
  it("appends JSON lines and reads them back, creating the directory", async () => {
    const path = defaultUsageLogPath(tempDir());
    appendUsageRecord(path, record({ pr: 1 }));
    appendUsageRecord(path, record({ pr: 2 }));
    const records = await collect(readUsageRecords(path));
    expect(records.map((r) => r.pr)).toEqual([1, 2]);
  });

  it("rejects a symlinked usage log directory", () => {
    const root = tempDir();
    const target = tempDir();
    symlinkSync(target, join(root, USAGE_LOG_DIR), "dir");
    expect(() => appendUsageRecord(defaultUsageLogPath(root), record())).toThrow(/symlink/);
  });

  it("rejects a symlinked usage log file", () => {
    const root = tempDir();
    const target = join(tempDir(), "target.jsonl");
    writeFileSync(target, "");
    mkdirSync(join(root, USAGE_LOG_DIR), { recursive: true });
    symlinkSync(target, defaultUsageLogPath(root));
    expect(() => appendUsageRecord(defaultUsageLogPath(root), record())).toThrow(/symlink/);
  });

  it("rejects a symlinked usage log when reading", async () => {
    const root = tempDir();
    const target = join(tempDir(), "target.jsonl");
    writeFileSync(target, `${JSON.stringify(record())}\n`);
    mkdirSync(join(root, USAGE_LOG_DIR), { recursive: true });
    symlinkSync(target, defaultUsageLogPath(root));
    await expect(collect(readUsageRecords(defaultUsageLogPath(root)))).rejects.toThrow(/symlink/);
    expect(() => findUsageLog(root)).toThrow(/symlink/);
  });

  it("skips blank and malformed lines without throwing", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, USAGE_LOG_DIR), { recursive: true });
    const path = join(dir, USAGE_LOG_DIR, USAGE_LOG_FILENAME);
    const partial = { provider: "anthropic", model: "claude-sonnet-4-6", inputTokens: 100 };
    writeFileSync(path, `${JSON.stringify(record({ pr: 7 }))}\n\nnot-json\n{"partial":true}\n${JSON.stringify(partial)}\n`);
    const records = await collect(readUsageRecords(path));
    expect(records).toHaveLength(1);
    expect(records[0].pr).toBe(7);
  });

  it("returns [] for a missing log", async () => {
    await expect(collect(readUsageRecords(join(tempDir(), "nope.jsonl")))).resolves.toEqual([]);
  });

  it("finds a log by searching upward", () => {
    const root = tempDir();
    const path = defaultUsageLogPath(root);
    appendUsageRecord(path, record());
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    expect(findUsageLog(nested)).toBe(path);
  });
});

describe("toUsageRecord", () => {
  it("projects a cost estimate into a record", () => {
    const estimate: CostEstimate = {
      provider: "openai",
      model: "gpt-5.2",
      inputTokens: 1,
      outputTokens: 2,
      cachedInputTokens: 3,
      cacheWriteInputTokens: 4,
      totalTokens: 10,
      usd: 0.5
    };
    expect(toUsageRecord(estimate, { ts: "T", repo: "o/r", pr: 9 })).toEqual({
      ts: "T",
      provider: "openai",
      model: "gpt-5.2",
      repo: "o/r",
      pr: 9,
      inputTokens: 1,
      outputTokens: 2,
      cachedInputTokens: 3,
      cacheWriteInputTokens: 4,
      usd: 0.5
    });
  });
});

describe("aggregateUsage", () => {
  it("totals tokens/cost and groups by provider/model, most-expensive first", () => {
    const agg = aggregateUsage([
      record({ model: "claude-sonnet-4-6", usd: 0.02, inputTokens: 100 }),
      record({ model: "claude-sonnet-4-6", usd: 0.03, inputTokens: 200, cacheWriteInputTokens: 30 }),
      record({ provider: "openai", model: "gpt-5.2", usd: 0.5, inputTokens: 10 })
    ]);
    expect(agg.runs).toBe(3);
    expect(agg.usd).toBeCloseTo(0.55, 5);
    expect(agg.inputTokens).toBe(310);
    expect(agg.cacheWriteInputTokens).toBe(30);
    expect(agg.totalTokens).toBe(520);
    expect(agg.groups[0].key).toBe("openai/gpt-5.2"); // highest cost first
    expect(agg.groups[1].runs).toBe(2);
    expect(agg.groups[1].cacheWriteInputTokens).toBe(30);
    expect(agg.priced).toBe(true);
  });

  it("marks the aggregate partial when any run has no known price", () => {
    const agg = aggregateUsage([record({ usd: 0.02 }), record({ usd: null })]);
    expect(agg.priced).toBe(false);
    expect(agg.usd).toBeCloseTo(0.02, 5); // null treated as 0 in the sum
    expect(agg.groups[0].priced).toBe(false);
  });

  it("reports the time window and handles an empty set", () => {
    const agg = aggregateUsage([record({ ts: "2026-06-10T00:00:00Z" }), record({ ts: "2026-06-14T00:00:00Z" })]);
    expect(agg.since).toBe("2026-06-10T00:00:00Z");
    expect(agg.until).toBe("2026-06-14T00:00:00Z");
    expect(aggregateUsage([]).runs).toBe(0);
  });

  it("orders the time window by parsed timestamps, including offsets", () => {
    const agg = aggregateUsage([
      record({ ts: "2026-06-14T00:30:00+02:00" }),
      record({ ts: "2026-06-13T23:00:00Z" })
    ]);
    expect(agg.since).toBe("2026-06-14T00:30:00+02:00");
    expect(agg.until).toBe("2026-06-13T23:00:00Z");
  });

  it("keeps the last timestamp string when parsed timestamps tie for until", () => {
    const agg = aggregateUsage([
      record({ ts: "2026-06-14T00:00:00Z" }),
      record({ ts: "2026-06-13T19:00:00-05:00" })
    ]);
    expect(agg.since).toBe("2026-06-14T00:00:00Z");
    expect(agg.until).toBe("2026-06-13T19:00:00-05:00");
  });
});
