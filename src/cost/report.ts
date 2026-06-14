import { formatUsd } from "./pricing.js";
import type { UsageAggregate } from "./usage-log.js";

/**
 * Human + machine renderers for the `prowl-review costs` command (backlog #36).
 * Mirrors the eval report's two-function style (markdown for the terminal, JSON
 * for agents/diffing).
 */

/** Render the usage aggregate as a markdown summary for the terminal. */
export function renderCostReportMarkdown(aggregate: UsageAggregate): string {
  if (aggregate.runs === 0) {
    return "# prowl-review cost report\n\nNo local usage recorded yet.";
  }

  const window =
    aggregate.since && aggregate.until ? `${aggregate.since} → ${aggregate.until}` : "—";
  const estimate = aggregate.priced ? "" : " (partial — some runs had no known price)";
  const lines = [
    "# prowl-review cost report",
    "",
    `**Runs:** ${aggregate.runs}  ·  **Window:** ${window}`,
    `**Estimated spend:** ~${formatUsd(aggregate.usd)}${estimate}`,
    `**Tokens:** ${aggregate.inputTokens.toLocaleString()} in · ` +
      `${aggregate.outputTokens.toLocaleString()} out · ` +
      `${aggregate.cachedInputTokens.toLocaleString()} cached`,
    "",
    "_Estimated from a built-in price table; your provider dashboard is the source of truth._",
    "",
    "| Provider / model | Runs | In | Out | Cached | Est. cost |",
    "| --- | ---: | ---: | ---: | ---: | ---: |"
  ];
  for (const group of aggregate.groups) {
    const cost = group.priced ? `~${formatUsd(group.usd)}` : "n/a";
    lines.push(
      `| ${group.key} | ${group.runs} | ${group.inputTokens.toLocaleString()} | ` +
        `${group.outputTokens.toLocaleString()} | ${group.cachedInputTokens.toLocaleString()} | ${cost} |`
    );
  }
  return lines.join("\n");
}

/** Render the usage aggregate as pretty JSON for agents/archival. */
export function renderCostReportJson(aggregate: UsageAggregate): string {
  return JSON.stringify(aggregate, null, 2);
}
