import { Command } from "commander";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_FILENAME } from "../../config/loader.js";
import { CONFIG_TEMPLATE } from "../../config/template.js";

/**
 * `prowl-review init` — scaffold a commented `.prowl-review.yml` (backlog #29).
 *
 * Writes the template into the target directory (the cwd by default). Refuses
 * to clobber an existing config unless `--force` is passed.
 */

interface InitCommandOptions {
  dir?: string;
  force?: boolean;
}

/** Write the config template to `dir`; returns the path written. Pure-ish for tests. */
export function writeConfigTemplate(dir: string, force: boolean): string {
  const target = join(resolve(dir), CONFIG_FILENAME);
  if (existsSync(target) && !force) {
    throw new Error(`${CONFIG_FILENAME} already exists at ${target}. Use --force to overwrite.`);
  }
  writeFileSync(target, CONFIG_TEMPLATE, "utf8");
  return target;
}

/** Build the `init` CLI command that scaffolds a config file. */
export function buildInitCommand(): Command {
  const command = new Command("init");

  command
    .description(`Scaffold a commented ${CONFIG_FILENAME} in the current directory`)
    .option("--dir <path>", "directory to write the config into (defaults to the current directory)")
    .option("--force", "overwrite an existing config file")
    .action((options: InitCommandOptions) => {
      const target = writeConfigTemplate(options.dir ?? process.cwd(), Boolean(options.force));
      console.log(`prowl-review: wrote ${target}`);
    });

  return command;
}
