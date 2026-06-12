import { Command } from "commander";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createOctokit } from "../../github/client.js";
import { reviewPullRequest } from "../../pipeline.js";
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

interface ReviewCommandOptions {
  pr?: string;
  repo?: string;
  minSeverity?: string;
  context?: boolean;
  verify?: boolean;
  grounding?: boolean;
  dryRun?: boolean;
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
    .option("--no-verify", "skip the skeptical false-positive verification pass")
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

      const octokit = createOctokit(token);
      const result = await reviewPullRequest(
        octokit,
        { owner, repo, pull_number: pullNumber },
        {
          toolkitRoot: root,
          skipContext: options.context === false,
          skipGrounding: options.grounding === false,
          verify: options.verify !== false,
          minSeverity: parseMinSeverity(options.minSeverity),
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
