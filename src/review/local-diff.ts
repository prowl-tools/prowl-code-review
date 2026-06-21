import { execFile } from "node:child_process";
import { DEFAULT_IGNORE as CONTEXT_DEFAULT_IGNORE } from "../context/tools.js";

/**
 * Local diff resolution for the pre-push CLI mode (backlog #35).
 *
 * Produces a unified diff from local git refs so the same review engine can run
 * against a branch before it is pushed — no GitHub, no token. The diff is taken
 * relative to the merge base of `base` and `head` (PR semantics: only the changes
 * `head` introduces on top of `base`, not unrelated commits that landed on
 * `base` since they diverged). When `head` is omitted the working tree is
 * compared against that merge base, so uncommitted edits are reviewed too.
 *
 * The git invocation is injectable so the resolver is unit-testable without a
 * real repository.
 */

/** Runs a `git` subcommand in a working directory and returns its stdout. */
export type GitExec = (args: string[]) => Promise<string>;

export interface ResolveLocalDiffOptions {
  /** Base ref to diff against (e.g. `main`). */
  base: string;
  /** Head ref; omitted compares the working tree against the merge base. */
  head?: string;
  /** Repository checkout the git commands run inside. */
  cwd: string;
  /** Injectable git runner (defaults to a confined `git` execFile). */
  exec?: GitExec;
}

export interface AssertLocalHeadOptions {
  /** Head ref; omitted or blank means the working tree is the review target. */
  head?: string;
  /** Repository checkout the git commands run inside. */
  cwd: string;
  /** Injectable git runner (defaults to a confined `git` execFile). */
  exec?: GitExec;
}

export interface ResolveLocalWorkspaceOptions {
  /** Environment values that may explicitly pin the workspace. */
  env: NodeJS.ProcessEnv;
  /** Directory the git command runs inside when no workspace env is set. */
  cwd: string;
  /** Injectable git runner (defaults to a confined `git` execFile). */
  exec?: GitExec;
}

/** Raised when the git diff cannot be produced (bad ref, not a repo, git missing). */
export class LocalDiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalDiffError";
  }
}

/** Default git runner: `execFile("git", …)` confined to `cwd`, bounded output. */
export function defaultGitExec(cwd: string): GitExec {
  return (args: string[]) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        args,
        { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) {
            const code = (error as { code?: unknown }).code;
            if (code === "ENOENT") {
              reject(new LocalDiffError("git was not found on PATH; install git to use local review."));
              return;
            }
            const detail = (stderr || error.message || "").trim();
            reject(new LocalDiffError(`git ${args.join(" ")} failed: ${detail}`));
            return;
          }
          resolve(stdout);
        }
      );
    });
}

function parseStatusPaths(output: string, statusCode: string): string[] {
  return output
    .split(/\0|\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(`${statusCode} `))
    .map((entry) => entry.slice(3))
    .filter(Boolean);
}

function isSkippedByContextTools(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.?\/+/, "").replace(/\/+$/, "");
  if (!normalized) {
    return false;
  }
  return normalized.split("/").some((segment) => CONTEXT_DEFAULT_IGNORE.includes(segment));
}

/** Resolve the local review workspace, defaulting to the repository top-level. */
export async function resolveLocalWorkspace(options: ResolveLocalWorkspaceOptions): Promise<string> {
  const explicit = options.env.PROWL_WORKSPACE?.trim() || options.env.GITHUB_WORKSPACE?.trim();
  if (explicit) {
    return explicit;
  }

  const exec = options.exec ?? defaultGitExec(options.cwd);
  return (await exec(["rev-parse", "--show-toplevel"])).trim();
}

/**
 * Local review reads context, guidelines, and grounding inputs from the checkout
 * itself. If a caller supplies `--head`, require it to be that checkout's HEAD
 * so those filesystem reads match the diff target.
 */
export async function assertLocalHeadMatchesCheckout(options: AssertLocalHeadOptions): Promise<void> {
  const head = options.head?.trim();
  if (!head) {
    return;
  }

  const exec = options.exec ?? defaultGitExec(options.cwd);
  const checkoutSha = (await exec(["rev-parse", "--verify", "HEAD"])).trim();
  const requestedSha = (await exec(["rev-parse", "--verify", "--end-of-options", `${head}^{commit}`])).trim();

  if (checkoutSha !== requestedSha) {
    throw new LocalDiffError(
      `--head ${head} does not match the checked-out HEAD; switch to that ref or omit --head to review the working tree.`
    );
  }

  const status = (await exec(["status", "--porcelain", "--untracked-files=normal"])).trim();
  if (status) {
    throw new LocalDiffError(
      `--head ${head} requires a clean worktree; commit or stash local changes, or omit --head to review the working tree.`
    );
  }

  const ignoredInputs = await exec(["status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=normal"]);
  const reviewVisibleIgnoredInputs = parseStatusPaths(ignoredInputs, "!!").filter(
    (path) => !isSkippedByContextTools(path)
  );
  if (reviewVisibleIgnoredInputs.length > 0) {
    const preview = reviewVisibleIgnoredInputs.slice(0, 3).join(", ");
    const suffix = reviewVisibleIgnoredInputs.length > 3 ? `, and ${reviewVisibleIgnoredInputs.length - 3} more` : "";
    throw new LocalDiffError(
      `--head ${head} requires ignored local files to be absent from review-readable paths (${preview}${suffix}); remove them or omit --head to review the working tree.`
    );
  }
}

/**
 * Resolve the unified diff for a local review. Uses `git diff --merge-base` so
 * the result matches what a pull request would show: changes `head` (or the
 * working tree) introduces relative to where it diverged from `base`.
 */
export async function resolveLocalDiff(options: ResolveLocalDiffOptions): Promise<string> {
  const base = options.base.trim();
  if (!base) {
    throw new LocalDiffError("A base ref is required for local review (pass --base <ref>).");
  }
  const head = options.head?.trim();
  const exec = options.exec ?? defaultGitExec(options.cwd);
  // `git diff --merge-base A [B]` == `git diff $(git merge-base A B|HEAD) B|<worktree>`.
  const args = [
    "diff",
    "--no-ext-diff",
    "--no-color",
    "--find-renames",
    "--merge-base",
    "--end-of-options",
    base,
    ...(head ? [head] : [])
  ];
  return exec(args);
}
