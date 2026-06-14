import { escapeMarkdownDisplayText, formatUsd } from "./pricing.js";
import type { UsageAggregate } from "./usage-log.js";

/**
 * Human + machine renderers for the `prowl-review costs` command (backlog #36).
 * Mirrors the eval report's two-function style (markdown for the terminal, JSON
 * for agents/diffing).
 */

function markdownTableCell(value: string): string {
  return escapeMarkdownDisplayText(value);
}

function markdownTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) {
    return new Date(parsed).toISOString();
  }
  return escapeMarkdownDisplayText(value);
}

/** Render the usage aggregate as a markdown summary for the terminal. */
export function renderCostReportMarkdown(aggregate: UsageAggregate): string {
  if (aggregate.runs === 0) {
    return "# prowl-review cost report\n\nNo local usage recorded yet.";
  }

  const window =
    aggregate.since && aggregate.until
      ? `${markdownTimestamp(aggregate.since)} → ${markdownTimestamp(aggregate.until)}`
      : "—";
  const estimate = aggregate.priced ? "" : " (partial — some runs had no known price)";
  const lines = [
    "# prowl-review cost report",
    "",
    `**Runs:** ${aggregate.runs}  ·  **Window:** ${window}`,
    `**Estimated spend:** ~${formatUsd(aggregate.usd)}${estimate}`,
    `**Tokens:** ${aggregate.inputTokens.toLocaleString()} in · ` +
      `${aggregate.outputTokens.toLocaleString()} out · ` +
      `${aggregate.cachedInputTokens.toLocaleString()} cached read · ` +
      `${aggregate.cacheWriteInputTokens.toLocaleString()} cache write`,
    "",
    "_Estimated from a built-in price table; your provider dashboard is the source of truth._",
    "",
    "| Provider / model | Runs | In | Out | Cached read | Cache write | Est. cost |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"
  ];
  for (const group of aggregate.groups) {
    const cost = group.priced ? `~${formatUsd(group.usd)}` : "n/a";
    const providerModel = markdownTableCell(`${group.provider}/${group.model}`);
    lines.push(
      `| ${providerModel} | ${group.runs} | ${group.inputTokens.toLocaleString()} | ` +
        `${group.outputTokens.toLocaleString()} | ${group.cachedInputTokens.toLocaleString()} | ` +
        `${group.cacheWriteInputTokens.toLocaleString()} | ${cost} |`
    );
  }
  return lines.join("\n");
}

/** Render the usage aggregate as pretty JSON for agents/archival. */
export function renderCostReportJson(aggregate: UsageAggregate): string {
  return JSON.stringify(aggregate, null, 2);
}
