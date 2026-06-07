import { Command } from "commander";
import pkg from "../../package.json";
import { buildReviewCommand } from "./commands/review.js";

export const CLI_VERSION = pkg.version;

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("prowl-review")
    .description("BYOK AI code review for pull requests — powered by your own LLM key")
    .version(CLI_VERSION);

  program.addCommand(buildReviewCommand());

  return program;
}
