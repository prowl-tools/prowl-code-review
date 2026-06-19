import { Command } from "commander";
import pkg from "../../package.json";
import { buildReviewCommand } from "./commands/review.js";
import { buildCommandCommand } from "./commands/command.js";
import { buildEvalCommand } from "./commands/eval.js";
import { buildInitCommand } from "./commands/init.js";
import { buildCostsCommand } from "./commands/costs.js";

/** Current CLI version read from the package manifest. */
export const CLI_VERSION = pkg.version;

/** Build the root Commander program and register all available subcommands. */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name("prowl-review")
    .description("BYOK AI code review for pull requests — powered by your own LLM key")
    .version(CLI_VERSION);

  program.addCommand(buildReviewCommand());
  program.addCommand(buildCommandCommand());
  program.addCommand(buildEvalCommand());
  program.addCommand(buildInitCommand());
  program.addCommand(buildCostsCommand());

  return program;
}
