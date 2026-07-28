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
trusted-base config/guidelines split, the fork + author-trust guards, and the
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
# Single branded checks row (#61): trigger off your CI workflow COMPLETING, not
# `pull_request`, so the auto-review adds no row to the PR checks list.
on:
  workflow_run:
    workflows: [CI] # your CI workflow's `name:`
    types: [completed]
permissions:
  pull-requests: write
  issues: write
  checks: write
  contents: read
  actions: read # PR-resolution fallback reads the completed CI run
jobs:
  review:
    uses: Prowl-qa/.github/.github/workflows/prowl-review.yml@v1
    secrets: inherit
```

### Single branded checks row (#61)

The auto-review is triggered by your **CI workflow completing** (`workflow_run`)
rather than by `pull_request`. A `workflow_run`-triggered workflow does not attach a
row to the PR checks list, so prowl-review shows up **exactly once** — as the branded
**Prowl Review** check run — instead of that row *plus* an octocat Actions row.

Two things this requires:

- **Your CI workflow must subscribe to the PR transitions** that should trigger a
  review. `workflow_run` does not preserve the original pull_request action, so CI
  itself has to fire on them:
  ```yaml
  on:
    pull_request:
      types: [opened, synchronize, ready_for_review, reopened]
  ```
- **Point `workflows:` at your CI workflow's `name:`.** The review then starts after
  CI finishes (≈1 min later). The reusable workflow resolves exactly one open PR from
  the `workflow_run` payload (falling back to a completed-run API lookup), skips fork
  and draft PRs, and hands the PR number to the action — so the branded check run is
  the only failure surface on the PR.

## Notes

- **Pin a version.** `@v1` (or a SHA) lets each repo opt into upgrades instead of
  tracking `main` silently.
- **Permissions must be granted by the caller.** A reusable workflow can only
  *reduce* the caller's `GITHUB_TOKEN` scopes, so the callers above grant
  `pull-requests`/`issues`/`checks: write`. That's why they're not zero-line.
- **`secrets: inherit`** passes all caller/org secrets through. To be explicit
  instead, map them: `secrets: { PROWL_AI_KEY: ${{ secrets.PROWL_AI_KEY }} }`.
- **Tunables** ride as `with:` inputs on the caller — `min-severity`,
  `ai-provider`, `ai-model`, `config-path`, `org-guidelines-path`,
  `org-guidelines-workspace`, `runs-on`.
- **Config & guidelines stay trusted.** The reusable workflows load
  `.prowl-review.yml` and `REVIEW_GUIDELINES.md`/`CLAUDE.md`/`LEARNED_PATTERNS.md`
  from the **base** checkout, never from PR code. Set `config-path:
  prowl-base/.prowl-review.yml` to use a committed config.
- **Self-hosted runners:** pass `runs-on:` to target your own labels.
- **Branded identity (#59):** add org secrets `PROWL_APP_ID` + `PROWL_APP_PRIVATE_KEY`
  (from a registered GitHub App with the raccoon avatar) and the reusable workflows
  post as your `prowl-review[bot]` automatically; without them they fall back to
  `github-actions[bot]`. See the "Branded bot identity" section of the
  [main README](../../README.md).

For a single self-contained repo (no org `.github`), use the standalone
templates in [`../workflows/`](../workflows) instead.
