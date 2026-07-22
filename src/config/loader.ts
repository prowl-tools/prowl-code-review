import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";
import { z } from "zod";
import { configSchema, type ProwlReviewConfig } from "./schema.js";

/**
 * `.prowl-review.yml` loader (backlog #29).
 *
 * Config is optional: a repo with no file reviews with built-in defaults, so
 * the GitHub Action runs out of the box. `loadConfig` searches upward from the
 * workspace for the file, parses + validates it, and returns the parsed config
 * (omitted keys stay `undefined` so each downstream module applies its own
 * default — the precedence merge lives in the review command).
 *
 * Both `.yml` and `.yaml` are accepted. A malformed YAML document or a config
 * that violates the schema is a loud error, never a silent fallback to defaults.
 */

/** Accepted config filenames, in preference order. */
export const CONFIG_FILENAMES = [".prowl-review.yml", ".prowl-review.yaml"] as const;

/** The canonical filename written by `prowl-review init`. */
export const CONFIG_FILENAME = CONFIG_FILENAMES[0];

/** Search `startDir` and its ancestors for a config file; return its path or null. */
export function findConfigPath(startDir: string): string | null {
  let current = path.resolve(startDir);
  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = path.join(current, name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export interface LoadConfigOptions {
  /** Directory to start the upward search from. Default `process.cwd()`. */
  cwd?: string;
  /** Explicit config path; skips the search. */
  configPath?: string;
  /** Skip loading entirely and use defaults (e.g. CLI `--no-config`). */
  disabled?: boolean;
}

export interface LoadedConfig {
  /** Parsed, validated config; empty object when no file was found. */
  config: ProwlReviewConfig;
  /** Resolved path of the loaded file, or null when none was used. */
  configPath: string | null;
}

/** Turn a Zod error into a readable, multi-line "what's wrong where" message. */
function formatValidationError(error: z.ZodError, file: string): string {
  const lines = error.issues.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `  - ${where}: ${issue.message}`;
  });
  return `Invalid ${path.basename(file)}:\n${lines.join("\n")}`;
}

/**
 * Load and validate the `.prowl-review.yml` config.
 *
 * Returns an empty config (defaults apply downstream) when no file is found or
 * config is disabled. Throws on a missing explicit path, a YAML parse failure,
 * or a schema violation.
 */
export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  if (options.disabled) {
    return { config: {}, configPath: null };
  }

  let resolvedPath: string | null;
  if (options.configPath) {
    resolvedPath = path.resolve(options.configPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Config file not found at ${resolvedPath}`);
    }
  } else {
    resolvedPath = findConfigPath(options.cwd ?? process.cwd());
    if (!resolvedPath) {
      return { config: {}, configPath: null };
    }
  }

  const raw = fs.readFileSync(resolvedPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = yaml.parse(raw) ?? {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse ${path.basename(resolvedPath)}: ${message}`, { cause: error });
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(formatValidationError(result.error, resolvedPath));
  }

  return { config: result.data, configPath: resolvedPath };
}
