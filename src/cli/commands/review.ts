import { Command } from "commander";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createOctokit } from "../../github/client.js";
import { reviewPullRequest, type ReviewPullRequestOptions } from "../../pipeline.js";
import { resolveProviderConfig } from "../../providers/index.js";
import { loadConfig } from "../../config/loader.js";
import type { ProwlReviewConfig } from "../../config/schema.js";
import { SEVERITIES, type Severity } from "../../review/findings.js";

/**
 * `prowl-review review` — review a pull request and publish findings.
 *
 * The entry point invoked by the GitHub Action: reads `GITHUB_TOKEN` +
 * `PROWL_AI_KEY` from the environment, resolves the repo/PR from flags or the
 * GitHub event, runs the full pipeline, and publishes (or, with `--dry-run`,
 * just reports) the review.
 */

/** Resolve and validate the target repository from a flag or GitHub Actions env. */
export function resolveRepo(flag?: string): { owner: string; repo: string } {
  const value = flag ?? process.env.GITHUB_REPOSITORY;
  if (!value) {
    throw new Error("Repository required: pass --repo <owner/repo> or set GITHUB_REPOSITORY.");
  }
  const parts = value.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("Repository required: pass --repo <owner/repo> or set GITHUB_REPOSITORY.");
  }
  const [owner, repo] = parts;
  return { owner, repo };
}

/** Resolve and validate the pull request number from a flag or event payload. */
export function resolvePullNumber(flag?: string): number {
  if (flag) {
    const parsed = Number(flag);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`Invalid --pr: ${flag}`);
    }
    return parsed;
  }
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath && existsSync(eventPath)) {
    try {
      const event = JSON.parse(readFileSync(eventPath, "utf8")) as {
        pull_request?: { number?: number };
        number?: number;
      };
      const number = event.pull_request?.number ?? event.number;
      if (number) {
        return number;
      }
    } catch {
      // fall through to the error below
    }
  }
  throw new Error("Pull request number required: pass --pr <n> (or run on a pull_request event).");
}

/** Load optional review guidelines from the repository root, preferring REVIEW_GUIDELINES.md. */
export function loadGuidelines(root: string): string | undefined {
  for (const name of ["REVIEW_GUIDELINES.md", "CLAUDE.md"]) {
    const path = join(root, name);
    if (existsSync(path)) {
      try {
        return readFileSync(path, "utf8");
      } catch {
        // ignore unreadable guideline files
      }
    }
  }
  return undefined;
}

/** Parse an optional severity threshold for filtering findings. */
export function parseMinSeverity(value: string | undefined): Severity | undefined {
  if (!value) {
    return undefined;
  }
  if (!(SEVERITIES as readonly string[]).includes(value)) {
    throw new Error(`Invalid --min-severity: ${value} (use one of ${SEVERITIES.join(", ")}).`);
  }
  return value as Severity;
}

/** Resolve the repository checkout used by context retrieval. */
export function resolveWorkspace(): string {
  return process.env.PROWL_WORKSPACE || process.env.GITHUB_WORKSPACE || process.cwd();
}

/** Resolve the explicit trusted checkout used to load review guidelines. */
export function resolveGuidelinesWorkspace(): string | undefined {
  return process.env.PROWL_GUIDELINES_WORKSPACE?.trim() || undefined;
}

/** Resolve whether repo-local tooling may execute in the review workspace. */
export function resolveTrustWorkspace(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.PROWL_TRUST_WORKSPACE?.trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}

interface ReviewCommandOptions {
  pr?: string;
  repo?: string;
  minSeverity?: string;
  context?: boolean;
  verify?: boolean;
  grounding?: boolean;
  trustWorkspace?: boolean;
  dryRun?: boolean;
  /** `--config <path>` → string; `--no-config` → false; otherwise true/undefined. */
  config?: string | boolean;
}

/** The pipeline-tuning options derived from CLI flags + the config file. */
type ResolvedReviewOptions = Pick<
  ReviewPullRequestOptions,
  | "minSeverity"
  | "minConfidence"
  | "maxFindings"
  | "verify"
  | "verifyConfidence"
  | "skipContext"
  | "contextLimits"
  | "skipGrounding"
  | "trustWorkspace"
  | "diffLimits"
>;

/** Drop undefined entries so an object of all-undefined collapses to undefined. */
function compact<T extends Record<string, unknown>>(obj: T): T | undefined {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as T) : undefined;
}

/**
 * Merge CLI flags with the `.prowl-review.yml` config into pipeline options.
 * Precedence is **CLI flag > config file > built-in default**: an omitted value
 * stays `undefined` so the pipeline/judge applies its own default. A disable
 * from either the CLI or the config switches a stage off (the CLI has no
 * positive re-enable flag). Workspace trust is intentionally out-of-band:
 * only the CLI flag or environment may enable repo-local code execution.
 * Pure and env-injectable for testing.
 */
export function resolveReviewOptions(
  cli: ReviewCommandOptions,
  config: ProwlReviewConfig,
  env: NodeJS.ProcessEnv = process.env
): ResolvedReviewOptions {
  return {
    minSeverity: parseMinSeverity(cli.minSeverity) ?? config.review?.minSeverity,
    minConfidence: config.review?.minConfidence,
    maxFindings: config.review?.maxFindings,
    verify: cli.verify === false ? false : config.review?.verify,
    verifyConfidence: config.review?.verifyConfidence,
    skipContext:
      cli.context === false || config.context?.enabled === false ? true : undefined,
    contextLimits: compact({
      maxRounds: config.context?.maxRounds,
      maxFiles: config.context?.maxFiles
    }),
    skipGrounding:
      cli.grounding === false || config.grounding?.enabled === false ? true : undefined,
    trustWorkspace:
      cli.trustWorkspace ?? resolveTrustWorkspace(env),
    diffLimits: compact({
      maxFiles: config.diff?.maxFiles,
      maxDiffBytes: config.diff?.maxBytes
    })
  };
}

/** Build the `review` CLI command wired to the end-to-end GitHub review pipeline. */
export function buildReviewCommand(): Command {
  const command = new Command("review");

  command
    .description("Review a pull request and publish findings")
    .option("--pr <number>", "pull request number (defaults to the GitHub event)")
    .option("--repo <owner/repo>", "repository (defaults to GITHUB_REPOSITORY)")
    .option("--min-severity <severity>", `drop findings below this severity (${SEVERITIES.join("|")})`)
    .option("--no-context", "skip agentic cross-file context retrieval")
    .option("--no-grounding", "skip linter/SAST grounding")
    .option("--trust-workspace", "allow repo-local linter/SAST tools to execute in the workspace")
    .option("--no-verify", "skip the skeptical false-positive verification pass")
    .option("--config <path>", "path to a .prowl-review.yml config (defaults to an upward search)")
    .option("--no-config", "ignore any .prowl-review.yml and use built-in defaults")
    .option("--dry-run", "build the review but do not publish it")
    .action(async (options: ReviewCommandOptions) => {
      const token = process.env.GITHUB_TOKEN;
      if (!token) {
        throw new Error("GITHUB_TOKEN environment variable is required to post reviews.");
      }

      const { owner, repo } = resolveRepo(options.repo);
      const pullNumber = resolvePullNumber(options.pr);
      const root = resolveWorkspace();
      const guidelinesRoot = resolveGuidelinesWorkspace();
      const guidelines = guidelinesRoot ? loadGuidelines(guidelinesRoot) : undefined;

      // `--no-config` makes commander set options.config to `false`.
      const { config } = loadConfig({
        cwd: root,
        configPath: typeof options.config === "string" ? options.config : undefined,
        disabled: options.config === false
      });
      const providerConfig = resolveProviderConfig(process.env, {
        provider: config.provider,
        model: config.model
      });
      const resolved = resolveReviewOptions(options, config);

      const octokit = createOctokit(token);
      const result = await reviewPullRequest(
        octokit,
        { owner, repo, pull_number: pullNumber },
        {
          ...resolved,
          config: providerConfig,
          toolkitRoot: root,
          guidelines,
          dryRun: Boolean(options.dryRun)
        }
      );

      const count = result.review.findings.length;
      const inline = result.payload.comments.length;
      console.log(
        `prowl-review: ${count} finding(s), ${inline} inline, ${result.contextFiles} context file(s) on ` +
          `${owner}/${repo}#${pullNumber} ${result.posted ? "— posted" : "— dry run (not posted)"}`
      );

      const outputPath = process.env.GITHUB_OUTPUT;
      if (outputPath) {
        try {
          appendFileSync(outputPath, `findings=${count}\nposted=${result.posted}\n`);
        } catch {
          // non-fatal: output file unavailable
        }
      }
    });

  return command;
}
