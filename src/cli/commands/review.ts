import { Command } from "commander";

/**
 * `prowl-review review` — review a pull request or a local diff.
 *
 * This is a scaffold placeholder. The review pipeline (diff fetch/parse,
 * agentic context, multi-pass review, presentation) lands in later backlog
 * items; for now the command exists so the CLI surface is discoverable.
 */
export function buildReviewCommand(): Command {
  const command = new Command("review");

  command
    .description("Review a pull request or local diff (not implemented yet)")
    .option("--pr <number>", "pull request number to review")
    .option("--base <ref>", "base git ref for a local diff review")
    .option("--head <ref>", "head git ref for a local diff review")
    .action(() => {
      console.error(
        "prowl-review: `review` is not implemented yet — see docs/backlog.md (items 3–10)."
      );
      process.exitCode = 1;
    });

  return command;
}
