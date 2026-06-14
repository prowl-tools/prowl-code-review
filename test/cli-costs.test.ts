import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSinceDays, filterRecordsSince, runCostsCommand } from "../src/cli/commands/costs.js";
import { appendUsageRecord, defaultUsageLogPath, type UsageRecord } from "../src/cost/usage-log.js";

let logSpy: ReturnType<typeof vi.spyOn>;
let tempDirs: string[] = [];

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "prowl-costs-"));
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
    usd: 0.0123,
    ...over
  };
}

describe("parseSinceDays", () => {
  const now = new Date("2026-06-14T12:00:00.000Z");
  it("returns a cutoff N days before now", () => {
    expect(parseSinceDays("7", now)).toBe(new Date("2026-06-07T12:00:00.000Z").toISOString());
  });
  it("returns undefined when not given", () => {
    expect(parseSinceDays(undefined, now)).toBeUndefined();
  });
  it("rejects non-positive / non-numeric values", () => {
    expect(() => parseSinceDays("0", now)).toThrow(/Invalid --since/);
    expect(() => parseSinceDays("x", now)).toThrow(/Invalid --since/);
  });
});

describe("filterRecordsSince", () => {
  it("keeps records at/after the cutoff", () => {
    const records = [record({ ts: "2026-06-01T00:00:00Z" }), record({ ts: "2026-06-13T00:00:00Z" })];
    const kept = filterRecordsSince(records, "2026-06-10T00:00:00Z");
    expect(kept).toHaveLength(1);
    expect(kept[0].ts).toBe("2026-06-13T00:00:00Z");
  });
  it("returns all records when there is no cutoff", () => {
    const records = [record(), record()];
    expect(filterRecordsSince(records, undefined)).toHaveLength(2);
  });
});

describe("runCostsCommand", () => {
  it("renders a markdown report from the log", async () => {
    const path = defaultUsageLogPath(tempDir());
    appendUsageRecord(path, record());
    appendUsageRecord(path, record({ usd: 0.02 }));

    const out = await runCostsCommand({ log: path }, { resolveLogPath: (p) => p ?? null });
    expect(out).toContain("# prowl-review cost report");
    expect(out).toContain("**Runs:** 2");
    expect(out).toContain("anthropic/claude-sonnet-4-6");
    expect(logSpy).toHaveBeenCalledWith(out);
  });

  it("renders JSON when --json is set", async () => {
    const path = defaultUsageLogPath(tempDir());
    appendUsageRecord(path, record());

    const out = await runCostsCommand({ log: path, json: true }, { resolveLogPath: (p) => p ?? null });
    const parsed = JSON.parse(out);
    expect(parsed.runs).toBe(1);
    expect(parsed.groups[0].key).toBe("anthropic/claude-sonnet-4-6");
  });

  it("reports an empty state when there is no log", async () => {
    const out = await runCostsCommand({}, { resolveLogPath: () => null });
    expect(out).toContain("No local usage recorded yet");
  });

  it("applies --since using the injected clock", async () => {
    const path = defaultUsageLogPath(tempDir());
    appendUsageRecord(path, record({ ts: "2026-06-01T00:00:00.000Z", usd: 1 }));
    appendUsageRecord(path, record({ ts: "2026-06-14T00:00:00.000Z", usd: 2 }));

    const out = await runCostsCommand(
      { log: path, since: "3", json: true },
      { resolveLogPath: (p) => p ?? null, now: () => new Date("2026-06-14T12:00:00.000Z") }
    );
    expect(JSON.parse(out).runs).toBe(1); // only the 2026-06-14 record is within 3 days
  });

  it("sanitizes terminal control characters in markdown output", async () => {
    const path = defaultUsageLogPath(tempDir());
    appendUsageRecord(path, record({ model: "claude|\u001b[31mred\u001b[0m<script>" }));

    const out = await runCostsCommand({ log: path }, { resolveLogPath: (p) => p ?? null });
    expect(out).toContain("anthropic/claude\\|redscript");
    expect(out).not.toContain("\u001b[31m");
    expect(out).not.toContain("<script>");
  });
});
