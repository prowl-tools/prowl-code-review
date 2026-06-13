import { Command } from "commander";
import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
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

function existingConfigError(target: string): Error {
  return new Error(`${CONFIG_FILENAME} already exists at ${target}. Use --force to overwrite.`);
}

function assertNoSymlinkTarget(target: string): void {
  try {
    if (lstatSync(target).isSymbolicLink()) {
      throw new Error(`Refusing to write ${CONFIG_FILENAME} through symlinked config target: ${target}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}

function assertNoSymlinkPath(root: string, targetDir: string): void {
  const rel = relative(root, targetDir);
  if (!rel) {
    return;
  }

  let current = root;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`Refusing to write ${CONFIG_FILENAME} through symlinked path: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}

function resolveTargetDir(dir: string, workspace: string): string {
  const root = realpathSync(resolve(workspace));
  const targetDir = resolve(root, dir);
  const rootBoundary = root.endsWith(sep) ? root : `${root}${sep}`;
  const targetBoundary = targetDir.endsWith(sep) ? targetDir : `${targetDir}${sep}`;
  const comparableRoot = process.platform === "win32" ? rootBoundary.toLowerCase() : rootBoundary;
  const comparableTarget = process.platform === "win32" ? targetBoundary.toLowerCase() : targetBoundary;
  if (!comparableTarget.startsWith(comparableRoot)) {
    throw new Error(`Refusing to write ${CONFIG_FILENAME} outside the workspace: ${targetDir}`);
  }
  assertNoSymlinkPath(root, targetDir);
  return targetDir;
}

/** Write the config template to `dir`; returns the path written. Pure-ish for tests. */
export function writeConfigTemplate(dir: string, force: boolean, workspace = process.cwd()): string {
  const target = join(resolveTargetDir(dir, workspace), CONFIG_FILENAME);
  assertNoSymlinkTarget(target);
  try {
    writeFileSync(target, CONFIG_TEMPLATE, { encoding: "utf8", flag: force ? "w" : "wx" });
  } catch (error) {
    if (!force && (error as NodeJS.ErrnoException).code === "EEXIST") {
      throw existingConfigError(target);
    }
    throw error;
  }
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
      const target = writeConfigTemplate(options.dir ?? ".", Boolean(options.force));
      console.log(`prowl-review: wrote ${target}`);
    });

  return command;
}
