import { Command } from "commander";
import { findUsageLog, readUsageRecords, aggregateUsage, aggregateUsageAsync, type UsageRecord } from "../../cost/usage-log.js";
import { renderCostReportMarkdown, renderCostReportJson } from "../../cost/report.js";

/**
 * `prowl-review costs` — report local token/cost usage (backlog #36).
 *
 * Reads the local `.prowl-review/usage.jsonl` (written by `review` on local
 * runs), aggregates per provider/model + totals, and prints a markdown summary
 * (or `--json` for agents). Covers local/pre-push runs; CI runs are ephemeral
 * and surface cost per-run in the Action logs/job summary instead, with the
 * provider dashboard as the source of truth for the real bill.
 */

interface CostsCommandOptions {
  log?: string;
  json?: boolean;
  since?: string;
}

/** Parse `--since <days>` into a cutoff ISO timestamp, or undefined. */
export function parseSinceDays(value: string | undefined, now: Date): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`Invalid --since: ${value} (use a positive number of days).`);
  }
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** Keep only records at/after `cutoff` (ISO compare); all records when no cutoff. */
export function filterRecordsSince(records: UsageRecord[], cutoff: string | undefined): UsageRecord[] {
  if (!cutoff) {
    return records;
  }
  return records.filter((record) => typeof record.ts === "string" && record.ts >= cutoff);
}

async function* filterRecordsSinceAsync(
  records: AsyncIterable<UsageRecord>,
  cutoff: string | undefined
): AsyncGenerator<UsageRecord> {
  for await (const record of records) {
    if (!cutoff || (typeof record.ts === "string" && record.ts >= cutoff)) {
      yield record;
    }
  }
}

export interface CostsCommandDeps {
  /** Resolve the usage-log path; defaults to an upward search from cwd. */
  resolveLogPath?: (cliPath: string | undefined) => string | null;
  now?: () => Date;
}

/** Run the costs command and return the rendered report (also printed to stdout). */
export async function runCostsCommand(options: CostsCommandOptions, deps: CostsCommandDeps = {}): Promise<string> {
  const now = deps.now?.() ?? new Date();
  const resolveLogPath =
    deps.resolveLogPath ?? ((cliPath) => cliPath ?? findUsageLog(process.cwd()));
  const logPath = resolveLogPath(options.log);

  const cutoff = parseSinceDays(options.since, now);
  const aggregate = logPath
    ? await aggregateUsageAsync(filterRecordsSinceAsync(readUsageRecords(logPath), cutoff))
    : aggregateUsage([]);

  const output = options.json ? renderCostReportJson(aggregate) : renderCostReportMarkdown(aggregate);
  console.log(output);
  return output;
}

/** Build the `costs` CLI command. */
export function buildCostsCommand(): Command {
  const command = new Command("costs");

  command
    .description("Report local token usage + estimated cost from .prowl-review/usage.jsonl")
    .option("--log <path>", "path to a usage.jsonl log (defaults to an upward search)")
    .option("--since <days>", "only include runs from the last N days")
    .option("--json", "output the aggregate as JSON")
    .action(async (options: CostsCommandOptions) => {
      await runCostsCommand(options);
    });

  return command;
}
