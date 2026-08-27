# CLI

prowl-review ships as a CLI — the same core the GitHub Action wraps. Install it
globally, run it with `npx`, or install from Homebrew:

```bash
npm install -g prowl-review
# or
npx prowl-review <command>
# or
brew install prowl-tools/tap/prowl-review
```

npm/npx need Node.js 22.13.0 or newer within Node 22, or Node 24+; the Homebrew
formula installs `node@22` itself.

All commands resolve the provider from `PROWL_AI_PROVIDER` (`anthropic` by
default), then read `PROWL_AI_KEY_<PROVIDER>` first and fall back to
`PROWL_AI_KEY` only when the provider-scoped key is absent. If neither key is set,
the run fails fast with a message naming both variables — see [Auth](auth.md).
The keyless `codex` provider needs no key at all; it uses the local `codex login`
session instead.

Commands: `review`, `command`, `eval`, `init`, `costs`.

## `prowl-review review`

Review a pull request (the Action entry point) or a local diff. Passing `--base`
(or `--head`) switches the command into **local mode**, where the GitHub flags
(`--pr`, `--repo`, `--dry-run`) are ignored and findings print to the terminal.

```bash
# Review a GitHub PR (token + repo + PR from flags or the Actions event)
PROWL_AI_KEY=sk-… prowl-review review --repo owner/name --pr 128

# Local pre-push review against a base ref (no GitHub needed)
PROWL_AI_KEY=sk-… prowl-review review --base main
```

The local diff is taken relative to the **merge base** of `--base` and `--head`
(PR semantics — only the changes your branch introduces). Omit `--head` to review
the working tree; untracked files aren't part of Git's working-tree diff, so
local mode fails with a clear prompt to stage or commit them first. When `--head`
is supplied it must resolve to the currently checked-out `HEAD` and the worktree
must be clean.

| Flag | Effect |
|---|---|
| `--pr <number>` | Pull request number (defaults to the GitHub event). |
| `--repo <owner/repo>` | Repository (defaults to `GITHUB_REPOSITORY`). |
| `--base <ref>` | Local mode: base git ref to diff against (no GitHub posting). |
| `--head <ref>` | Local mode: checked-out clean head ref (defaults to the working tree). |
| `--min-severity <level>` | Drop findings below this severity (`critical\|major\|minor\|trivial\|info`). |
| `--no-context` | Skip agentic cross-file context retrieval. |
| `--no-grounding` | Skip linter/SAST grounding. |
| `--no-verify` | Skip the skeptical false-positive verification pass. |
| `--no-incremental` | Review the full PR diff, not just the delta since the last review. |
| `--no-resolve-threads` | Leave prior finding threads untouched (skip resolve + reply handling). |
| `--no-agent-prompt` | Omit the per-finding "Resolve with an AI agent" prompt. |
| `--trust-workspace` | Allow repo-local linter/SAST tools to execute in the workspace. |
| `--config <path>` | Path to a `.prowl-review.yml` (defaults to an upward search). |
| `--no-config` | Ignore any `.prowl-review.yml` and use built-in defaults. |
| `--dry-run` | Build the review but don't publish it. |
| `--debug [path]` | Write a structured JSONL run trace (prompts, context, findings, cost); defaults to `.prowl-review/debug.jsonl`. |
| `--json` | Local mode: print findings as JSON instead of the human report. |
| `--no-color` | Local mode: disable ANSI color (also honors `NO_COLOR`). |
| `--fail-on <level>` | Local mode: exit non-zero on a finding at/above this severity — wire it into a pre-push hook as a gate. |

`--json`, `--no-color`, and `--fail-on` require `--base` or `--head`. Per-run cost
prints to stderr, so `--json` stdout stays clean.

## `prowl-review command`

Handle an `@prowl-review` comment — the command-mode Action entry. It reads the
`issue_comment` / `pull_request_review_comment` event from the environment and
ignores mentions from untrusted authors. See [Bot commands](bot-commands.md).

| Flag | Effect |
|---|---|
| `--repo <owner/repo>` | Repository (defaults to `GITHUB_REPOSITORY`). |

## `prowl-review init`

Scaffold a fully commented `.prowl-review.yml` in the current directory. Every
option is commented out, so a fresh file documents the knobs without changing
behavior until you opt in.

| Flag | Effect |
|---|---|
| `--dir <path>` | Directory to write the config into (defaults to the current directory). |
| `--force` | Overwrite an existing config file. |

## `prowl-review costs`

Report local token usage and estimated cost from `.prowl-review/usage.jsonl`.

| Flag | Effect |
|---|---|
| `--log <path>` | Path to a `usage.jsonl` log (defaults to an upward search). |
| `--since <days>` | Only include runs from the last N days. |
| `--json` | Output the aggregate as JSON. |

Cost figures are always estimates; your provider dashboard is the source of
truth. Override stale rates with the `pricing` block in
[Configuration](configuration.md).

## `prowl-review eval`

Score the reviewer against an in-repo benchmark of PRs with known bugs (and clean
PRs that should stay quiet) — precision / recall / F1, with CI gates. Useful for
proving prompt/model/threshold changes don't regress. See [eval](eval.md).

```bash
PROWL_AI_KEY=sk-… prowl-review eval --min-precision 0.8 --min-recall 0.7
```

| Flag | Effect |
|---|---|
| `--bench <dir>` | Benchmark directory (defaults to `./bench`). |
| `--json <path>` | Write the full JSON report to this path. |
| `--line-window <n>` | Line tolerance when matching findings to bugs (default 3). |
| `--require-category` | Require a finding's category to match the expected bug. |
| `--no-verify` | Skip the false-positive verification pass during the run. |
| `--min-severity <level>` | Drop findings below this severity (mirrors the review default). |
| `--min-precision <n>` | Fail if precision is below this 0–1 threshold. |
| `--min-recall <n>` | Fail if recall is below this 0–1 threshold. |
| `--min-f1 <n>` | Fail if F1 is below this 0–1 threshold. |
