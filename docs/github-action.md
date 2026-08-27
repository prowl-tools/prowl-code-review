# GitHub Action

prowl-review runs as a composite GitHub Action. It posts one cohesive review
(walkthrough summary + inline findings), updates it in place on each push, and can
also run in command mode for `@prowl-review` chat.

## Auto-review workflow

The simplest setup — a standalone `pull_request`-triggered workflow:

```yaml
# .github/workflows/prowl-review.yml
name: prowl-review
on:
  pull_request:
    types: [opened, synchronize, ready_for_review, reopened]

# Serialize auto reviews with bot commands for the same PR. Non-cancelling so
# an in-flight maintainer command isn't interrupted; a stale auto review skips
# publishing when the PR head has advanced.
concurrency:
  group: prowl-review-${{ github.event.pull_request.number }}
  cancel-in-progress: false

permissions:
  pull-requests: write   # post the review + inline comments
  issues: write          # summary comment + repo-wide learnings
  checks: write          # optional merge-gate check run
  contents: read
jobs:
  review:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: prowl-tools/prowl-code-review@v1
        with:
          ai-key: ${{ secrets.PROWL_AI_KEY }}
          # min-severity: major
          # ai-provider: anthropic   # anthropic | openai | gemini | codex
```

> **One checks row or two?**
> A `pull_request`-triggered workflow always adds its own octocat Actions row to
> the PR checks list. With the default `checkRun.enabled: false`, that Actions row
> is the only prowl-review status. If you also enable the branded
> [Prowl Review check run](#check-run), prowl-review appears twice. For the branded
> row **only**, use the [single-row `workflow_run` setup](#single-branded-row-workflow_run) below.

Copy-paste starters live in [`examples/workflows/`](../examples/workflows/).

## Single branded row (`workflow_run`)

Workflows triggered by `workflow_run` — "run when CI finishes" — attach **no row**
to the PR checks list. Chaining the auto-review off your CI workflow makes the
branded **Prowl Review** check run the only prowl-review presence on the PR:

```yaml
# .github/workflows/prowl-review.yml
name: prowl-review
on:
  workflow_run:
    workflows: [CI]        # the `name:` of your CI workflow
    types: [completed]
permissions:
  pull-requests: write
  issues: write
  checks: write
  contents: read
  actions: read            # read the completed CI run for PR resolution
jobs:
  review:
    if: ${{ github.event.workflow_run.event == 'pull_request' && github.event.workflow_run.conclusion == 'success' }}
    # Resolve the PR number, then pass it to prowl-review with `pr-number`.
```

Requirements and behavior:

- **Your CI workflow must subscribe to the PR transitions** that should trigger a
  review (`workflow_run` does not preserve the original action):
  `on: pull_request: types: [opened, synchronize, ready_for_review, reopened]`.
- The workflow is triggered after each completed CI run, but the review job runs
  only when CI **succeeds** and that CI run came from a `pull_request` event;
  failed, cancelled, or non-PR CI runs skip the review.
- The workflow resolves the PR from the `workflow_run` payload (requiring exactly
  one open PR at the CI head SHA) and hands it to the action via the `pr-number`
  input (and `pr-draft` for the draft state); fork and draft PRs are skipped safely.
- The [check run](#check-run) becomes the only prowl-review status on the PR —
  keep `checkRun.enabled: true` so reviews stay visible.

The full PR-resolution wiring lives in the maintained templates — copy
[`examples/reusable/`](../examples/reusable/) (org-wide, recommended) rather than
hand-rolling it. The standalone `pull_request` variant above remains fully
supported when the extra Actions row doesn't bother you.

## Inputs

| Input | Default | Purpose |
|---|---|---|
| `ai-key` | — | Generic provider key (single-provider). Pass a secret. |
| `ai-key-anthropic` | `""` | Anthropic key → `PROWL_AI_KEY_ANTHROPIC`. |
| `ai-key-openai` | `""` | OpenAI key → `PROWL_AI_KEY_OPENAI`. |
| `ai-key-gemini` | `""` | Gemini key → `PROWL_AI_KEY_GEMINI`. |
| `ai-provider` | `""` | Provider override: `anthropic` \| `openai` \| `gemini` \| `codex`. See [Codex](#codex-provider-ai-provider-codex). |
| `ai-model` | `""` | Model override (per-provider default otherwise). |
| `config-path` | `""` | Trusted `.prowl-review.yml` path. Empty = repo config is ignored. See [Trusted config](#trusted-config). |
| `check-run` | `""` | Publish the branded Prowl Review check run. Blank = use config; `true`/`false` overrides it. |
| `min-severity` | `""` | Drop findings below this severity (`critical\|major\|minor\|trivial\|info`). |
| `dry-run` | `false` | Build the review but don't publish it. |
| `debug` | `false` | Write a structured JSONL run trace under the workspace; upload it with `actions/upload-artifact` to inspect. |
| `workspace-path` | `GITHUB_WORKSPACE` | Repository checkout used for context lookup. |
| `guidelines-path` | `""` | Trusted checkout used to load `REVIEW_GUIDELINES.md` / `CLAUDE.md` / `LEARNED_PATTERNS.md`. Omit to disable repo guidelines. |
| `org-guidelines-path` | `""` | Org-wide guidelines file **or** `http(s)` URL, injected into every review. |
| `org-guidelines-workspace` | Actions workspace | Trusted root used to validate a local `org-guidelines-path`. |
| `trust-workspace` | `false` | Allow repo-local linter/SAST tools to execute. Force-disabled for fork PR events. |
| `github-token` | `${{ github.token }}` | Token used to post (needs `pull-requests: write` + `issues: write`). |
| `bot-login` | `""` | Login the review posts as, for a custom GitHub App token (e.g. `your-app[bot]`), so update-not-duplicate finds prior comments. |
| `mode` | `review` | `review` for a PR review, or `command` to handle an `@prowl-review` comment. |
| `pr-number` | `""` | Explicit PR number — required for [`workflow_run`-triggered](#single-branded-row-workflow_run) workflows. Empty = resolve from the event. |
| `pr-draft` | `""` | Explicit draft state for `workflow_run` review runs. Empty = resolve from the event. |

Outputs: `findings` (number of findings produced) and `posted` (whether the review
was posted).

Per-provider key inputs are exported to their env var **only when non-empty**, so
a blank input never clobbers a key already present in the runner environment.

For a custom GitHub App identity, mint a short-lived installation token before
this Action runs, pass that token as `github-token`, and set `bot-login` to the
App bot login — see [Auth](auth.md#bring-your-own-bot-identity) and
[`examples/workflows/prowl-review-branded.yml`](../examples/workflows/prowl-review-branded.yml).

See [Auth](auth.md) for how keys are passed (masked secrets, env-only) and
[Privacy](privacy.md) for what leaves the runner.

## Trusted config

The Action **ignores repo config unless you pass a trusted `config-path`** — check
out the base branch to a separate path and point `config-path` at it, so a PR
author can't change review policy from their branch:

```yaml
- uses: actions/checkout@v4
- uses: actions/checkout@v4
  with:
    ref: ${{ github.event.pull_request.base.sha }}
    path: prowl-review-config
    persist-credentials: false
- uses: prowl-tools/prowl-code-review@v1
  with:
    ai-key: ${{ secrets.PROWL_AI_KEY }}
    config-path: prowl-review-config/.prowl-review.yml
```

Config and guidelines always load from the trusted base, never from PR code.
Workspace execution trust is never read from config at all — it comes only from
the `trust-workspace` input.

## Codex provider (`ai-provider: codex`)

`ai-provider: codex` runs the review through a **ChatGPT subscription** instead of
a metered API key: pass **no `ai-key*` inputs at all**, and the Action uses the
runner's own `codex login` session. Per-review cost reports as
**`$0.00 (ChatGPT subscription)`**.

It is restricted by design:

- **Self-hosted runners only.** Under `GITHUB_ACTIONS=true`, prowl-review runs
  `codex` iff `RUNNER_ENVIRONMENT=self-hosted` — **regardless of repository
  visibility**. A GitHub-hosted runner is refused, and a missing
  `RUNNER_ENVIRONMENT` fails closed.
- **The login never enters GitHub.** `auth.json` lives in `$CODEX_HOME` on the
  host and is never read, copied, logged, or placed in Actions secrets.
- **Job-level same-repo and approved-actor gate**, so a fork PR or unauthorized
  same-repo PR is never scheduled onto the runner. Required on a public repo; a
  private repo may drop the fork gate.

```yaml
jobs:
  review:
    # Same-repo + approved-actor gate: see the self-hosted example for the full
    # hosted resolve job that checks PROWL_REVIEW_ALLOWED_ACTORS before scheduling.
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: [self-hosted, macOS, prowl-review]
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: prowl-tools/prowl-code-review@v1
        with:
          ai-provider: codex     # keyless — no ai-key* inputs
```

When the subscription allowance runs out, the merge-gate check completes
**neutral** ("Review skipped/incomplete") with the reason and a reset hint rather
than failing or posting a partial review, and the usage limit is never retried.
Re-run with `@prowl-review review` after the window resets.

Full runner setup — labels, `CODEX_HOME`, service `.env`/`.path`, registration
scope, and the machine-wide serialization lock — is in
[Self-hosted runner](self-hosted-runner.md). Copy-paste workflows:
[`prowl-review-self-hosted-codex.yml`](../examples/workflows/prowl-review-self-hosted-codex.yml)
and its command variant.

## Check run

With `checkRun.enabled: true` (or the `check-run` input) and the `checks: write`
permission, each review also surfaces as a **Prowl Review** row in the PR checks
list. The row is created **in-progress** the moment review work starts and
completes in place when the review posts — so it shows a live running state and a
duration, like any CI check. When you post with a
[custom GitHub App token](auth.md#bring-your-own-bot-identity), the row carries
your App's avatar.

Conclusions:

- **Gated (`failOn: <severity>`)** — the check completes green (`success`) when no
  finding lands at or above that severity, and red (`failure`) when one does — a
  visual verdict with severity counts and per-line annotations. If review work
  cannot complete after the row has started, the check fails closed (`failure`)
  rather than completing neutral, so branch protection cannot be satisfied after
  a runtime error. It does not block merging unless you mark the check **Required**
  in branch protection (required check name: `Prowl Review`).
- **Informational (no `failOn`)** — the check completes grey (`neutral`), reporting
  severity counts without implying a pass/fail verdict. GitHub can treat neutral
  checks as successful for required-check purposes, so set `failOn` if you want a
  severity-based merge gate.
- **Neutral** is also used for reviews that deliberately didn't run (paused,
  on-demand-only, draft), that were superseded by a newer commit, or that were
  skipped/incomplete for a runner-side reason such as a Codex usage limit or a
  logged-out `codex` CLI. Runtime errors on a started, non-superseded run close as
  `failure`. A started run is always closed out — it never dangles "in progress".

## Commands

Add a second workflow for `@prowl-review` chat/commands:

```yaml
# .github/workflows/prowl-review-command.yml
name: prowl-review command
on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
permissions:
  pull-requests: write
  issues: write
  checks: write
  contents: read
jobs:
  command:
    if: >
      contains(github.event.comment.body, '@prowl-review') &&
      (
        github.event_name == 'pull_request_review_comment' ||
        github.event.issue.pull_request
      )
    concurrency:
      group: prowl-review-${{ github.event.issue.number }}
      cancel-in-progress: false
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: prowl-tools/prowl-code-review@v1
        with:
          mode: command
          ai-key: ${{ secrets.PROWL_AI_KEY }}
```

`issue_comment` covers PR conversation comments; `pull_request_review_comment`
covers inline finding-thread replies (`ignore`, `resolve`, in-thread questions).
Each inline comment creates a workflow run, so leave that trigger out if you don't
need it. prowl-review re-checks author trust itself, so the `if:` guard is defense
in depth, not the only gate. See [Bot commands](bot-commands.md) for the verbs.

## Reusable org workflow

To run prowl-review across a whole org without copy-pasting the full workflow,
define it once in your org's `.github` repo as a `workflow_call` (reusable)
workflow, then each repo opts in with a few lines:

```yaml
name: prowl-review
# Single-row setup: chain off your CI workflow so the branded Prowl Review
# check run is the only prowl-review row on the PR. Your CI workflow must
# subscribe to the PR transitions that should trigger a review.
on:
  workflow_run:
    workflows: [CI]        # the `name:` of this repo's CI workflow
    types: [completed]
permissions:
  pull-requests: write
  issues: write
  checks: write
  contents: read
  actions: read            # PR-resolution fallback reads the completed CI run
jobs:
  review:
    if: ${{ github.event.workflow_run.event == 'pull_request' && github.event.workflow_run.conclusion == 'success' }}
    # Replace YOUR-ORG with the org or owner that hosts the reusable workflow.
    uses: YOUR-ORG/.github/.github/workflows/prowl-review.yml@v1
    secrets: inherit
    with:
      # workflow_run hides this workflow's Actions row, so keep the branded
      # replacement check visible unless another required status owns the gate.
      check-run: true
```

Templates live in the repo under [`examples/reusable/`](../examples/reusable/).
They pick up a custom GitHub App identity automatically when `PROWL_APP_ID` /
`PROWL_APP_PRIVATE_KEY` are set, falling back to the default token otherwise.

## Draft PRs & forks

Drafts are skipped by default (set `review.reviewDrafts: true`, or comment
`@prowl-review review` on demand). Keep draft handling **out** of the job-level
`if:` — a `draft == false` guard prevents the Action from ever seeing drafts, so
`reviewDrafts: true` could never take effect. When an auto review is skipped
(paused, draft, or `auto: false`) and the merge-gate check is enabled,
prowl-review posts a neutral check so a Required "Prowl Review" check isn't left
pending.

In `pull_request` workflows, fork PRs don't receive secrets, so a missing-key
fork run is skipped safely, and the fork checkout is never trusted: repo-local
linters don't execute and `.prowl-review.yml` isn't auto-discovered from it. The
recommended `pull_request` guard also restricts to same-repo heads before any
self-hosted runner is scheduled. To review fork PRs anyway, use a
`pull_request_target` workflow: it runs in the trusted base-repository context
and can receive secrets, but must check out the trusted base for config and pass
the PR head as an untrusted `workspace-path` — see
[Fork pull requests](../README.md#fork-pull-requests-20) and
[Auth](auth.md#fork-pull-requests).
