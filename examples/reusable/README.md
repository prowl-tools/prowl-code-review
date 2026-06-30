# Reusable org-level workflow (#37)

Run prowl-review across **all** your org's repos without copy-pasting the full
workflow into each one. Define the workflow **once** in your org's special
[`.github` repository](https://docs.github.com/en/actions/using-workflows/reusing-workflows),
then every repo opts in with a few lines.

## One-time org setup

In your org's **`.github`** repo (create it if it doesn't exist), add:

| This file | from |
|---|---|
| `.github/workflows/prowl-review.yml` | [`prowl-review.yml`](prowl-review.yml) |
| `.github/workflows/prowl-review-command.yml` | [`prowl-review-command.yml`](prowl-review-command.yml) |

These are `workflow_call` (reusable) workflows: they own the checkout, the
trusted-base config/guidelines split, the fork/draft guards, and the
`prowl-tools/prowl-code-review@v1` invocation. Add the provider key(s) as **org
secrets** (Settings → Secrets and variables → Actions) — e.g. `PROWL_AI_KEY`, or
`PROWL_AI_KEY_ANTHROPIC` + `PROWL_AI_KEY_GEMINI` for the ensemble — and make them
available to the repos that should be reviewed.

## Per-repo opt-in (a few lines)

In each repo to review, add the tiny callers:

| This file | from |
|---|---|
| `.github/workflows/prowl-review.yml` | [`caller-prowl-review.yml`](caller-prowl-review.yml) |
| `.github/workflows/prowl-review-command.yml` | [`caller-prowl-review-command.yml`](caller-prowl-review-command.yml) |

Each caller just declares the trigger + token permissions and points at the org
workflow with `secrets: inherit`:

```yaml
name: prowl-review
on:
  pull_request:
    types: [opened, synchronize, ready_for_review, reopened]
permissions:
  pull-requests: write
  issues: write
  checks: write
  contents: read
jobs:
  review:
    uses: Prowl-qa/.github/.github/workflows/prowl-review.yml@v1
    secrets: inherit
```

## Notes

- **Pin a version.** `@v1` (or a SHA) lets each repo opt into upgrades instead of
  tracking `main` silently.
- **Permissions must be granted by the caller.** A reusable workflow can only
  *reduce* the caller's `GITHUB_TOKEN` scopes, so the callers above grant
  `pull-requests`/`issues`/`checks: write`. That's why they're not zero-line.
- **`secrets: inherit`** passes all caller/org secrets through. To be explicit
  instead, map them: `secrets: { PROWL_AI_KEY: ${{ secrets.PROWL_AI_KEY }} }`.
- **Tunables** ride as `with:` inputs on the caller — `min-severity`,
  `ai-provider`, `ai-model`, `config-path`, `org-guidelines-path`, `runs-on`.
- **Config & guidelines stay trusted.** The reusable workflows load
  `.prowl-review.yml` and `REVIEW_GUIDELINES.md`/`CLAUDE.md`/`LEARNED_PATTERNS.md`
  from the **base** checkout, never from PR code. Set `config-path:
  prowl-base/.prowl-review.yml` to use a committed config.
- **Self-hosted runners:** pass `runs-on:` to target your own labels.

For a single self-contained repo (no org `.github`), use the standalone
templates in [`../workflows/`](../workflows) instead.
