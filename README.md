# prowl-review

**BYOK (bring-your-own-key) AI code review for pull requests** — the code-review pillar of the [Prowl QA](https://prowl.tools) suite.

`prowl-review` reviews pull requests (summary + inline comments + `@prowl-review` chat) using your **own** LLM key — Claude (default), OpenAI, or Gemini — with **no usage caps imposed by us**. Because your key pays the provider directly, there's nothing to rate-limit: the only ceiling is your provider's own limits, which dwarf the per-hour caps of commercial reviewers.

It's delivered as a **GitHub Action + local CLI** (zero hosting), and is built to match — not just approximate — the quality of CodeRabbit/Greptile via agentic cross-file context, multi-pass specialized review, linter/SAST grounding, and false-positive verification.

> Status: **early development.** This package currently contains the project scaffold and CLI surface. See [`docs/backlog.md`](docs/backlog.md) for the roadmap and [`CLAUDE.md`](CLAUDE.md) for the design principles.

## Usage (GitHub Action)

Add a workflow that runs the review on pull requests. For single-provider
reviews, store your provider key as the `PROWL_AI_KEY` repository secret.

```yaml
# .github/workflows/prowl-review.yml
name: prowl-review

on:
  pull_request:
    types: [opened, synchronize, ready_for_review, reopened]

# Queue reviews and bot commands for the same PR so command side effects are not
# lost when new commits arrive. prowl-review re-checks the PR head before
# publishing and skips if it advanced, so queued stale reviews do not post.
concurrency:
  group: prowl-review-${{ github.event.pull_request.number }}
  queue: max
  cancel-in-progress: false

permissions:
  pull-requests: write   # post the review + inline comments
  issues: write          # create/update the summary comment
  checks: write          # optional merge-gate check run
  contents: read

jobs:
  review:
    # Forks don't receive provider secrets. Draft handling happens inside
    # prowl-review so review.reviewDrafts can opt into draft auto-reviews.
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # Optional: load Action config from the trusted base branch, not from PR code.
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.base.sha }}
          path: prowl-review-config
          persist-credentials: false
      - uses: prowl-tools/prowl-code-review@v1
        with:
          ai-key: ${{ secrets.PROWL_AI_KEY }}
          # config-path: prowl-review-config/.prowl-review.yml
          # ai-provider: anthropic   # optional anthropic | openai | gemini override
          # ai-model: claude-...     # optional per-provider model override
```

For ensemble reviews with provider-specific keys, omit `ai-key` and pass
`PROWL_AI_KEY_ANTHROPIC`, `PROWL_AI_KEY_OPENAI`, or `PROWL_AI_KEY_GEMINI` as
step env vars instead.

The `concurrency` block is the recommended pattern: keying the group to the PR
number serializes auto reviews with bot commands. `queue: max` and
`cancel-in-progress: false` preserve maintainer-requested side effects such as
`pause`, `resume`, and `break glass`; stale queued auto reviews skip publishing
when the PR head has advanced.

### Draft PRs & on-demand review (#28)

By default prowl-review **skips draft PRs** and reviews automatically once a PR
is marked *ready for review* (keep `ready_for_review` in the workflow's
`on.pull_request.types`). An explicit `@prowl-review review` reviews a draft
on demand. Two `.prowl-review.yml` keys tune this:

```yaml
review:
  reviewDrafts: true   # also auto-review drafts (default false)
  auto: false          # on-demand only: review just when asked with @prowl-review review (default true)
```

The Action ignores repo config unless a trusted `config-path` input is set. To
use these keys in CI, create `.prowl-review.yml` on the base branch, check out
that base branch to a separate path, and pass that path as `config-path` (for
example `prowl-review-config/.prowl-review.yml`). Do not point `config-path` at
the PR checkout; same-repo PR authors could alter review policy in their branch.
Keep draft handling out of the job-level `if`; a `draft == false` guard prevents
the Action from seeing drafts, so `review.reviewDrafts: true` cannot take effect.

When an auto review is skipped (paused, drafts, or `auto: false`) and the
merge-gate check is enabled, prowl-review posts a neutral check run so a Required
"prowl-review" check isn't left pending.

### Bot commands

Drive the reviewer from the PR by commenting `@prowl-review <command>` (only a
repo owner/member/collaborator is honored):

| Command | Effect |
|---|---|
| `@prowl-review review` | Re-review the latest changes (incremental). |
| `@prowl-review full review` | Re-scan the entire PR from scratch. |
| `@prowl-review ignore` | Reply on a finding to mute it — it won't be raised again on this PR (#30). |
| `@prowl-review pause` | Stop auto-reviewing this PR on new pushes. |
| `@prowl-review resume` | Re-enable auto-review. |
| `@prowl-review help` | List the available commands. |
| `@prowl-review <question>` | Ask a free-form question — answered in-thread, grounded in the PR diff (#27). |

Anything after the mention that isn't a known command is treated as a question:
`@prowl-review why is this loop O(n²)?` gets a contextual reply in the same
thread (inline, when asked on a specific review comment). The command workflow
listens on both `issue_comment` and `pull_request_review_comment`:

```yaml
# .github/workflows/prowl-review-command.yml
name: prowl-review command
on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
concurrency:
  group: prowl-review-${{ github.event.issue.number || github.event.pull_request.number }}
  queue: max
  cancel-in-progress: false
permissions:
  pull-requests: write
  checks: write
  issues: write
  contents: read
jobs:
  command:
    if: |
      (github.event.issue.pull_request || github.event.pull_request) &&
      github.event.comment.user.type != 'Bot' &&
      (
        github.event.comment.author_association == 'OWNER' ||
        github.event.comment.author_association == 'MEMBER' ||
        github.event.comment.author_association == 'COLLABORATOR'
      ) &&
      contains(github.event.comment.body, '@prowl-review')
    runs-on: ubuntu-latest
    steps:
      - id: pr
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          pr_number="${{ github.event.issue.number || github.event.pull_request.number }}"
          base_sha="$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${pr_number}" --jq '.base.sha')"
          head_sha="$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${pr_number}" --jq '.head.sha')"
          head_repo="$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${pr_number}" --jq '.head.repo.full_name')"
          echo "base_sha=${base_sha}" >> "$GITHUB_OUTPUT"
          echo "head_sha=${head_sha}" >> "$GITHUB_OUTPUT"
          if [ "${head_repo}" = "${GITHUB_REPOSITORY}" ]; then
            echo "trusted_head=true" >> "$GITHUB_OUTPUT"
          else
            echo "trusted_head=false" >> "$GITHUB_OUTPUT"
          fi
      - uses: actions/checkout@v4
        with:
          ref: ${{ steps.pr.outputs.base_sha }}
      - uses: actions/checkout@v4
        if: steps.pr.outputs.trusted_head == 'true'
        with:
          ref: ${{ steps.pr.outputs.head_sha }}
          path: pr-head
      - uses: prowl-tools/prowl-code-review@v1
        if: steps.pr.outputs.trusted_head == 'true'
        env:
          PROWL_REVIEWED_HEAD_SHA: ${{ steps.pr.outputs.head_sha }}
        with:
          mode: command
          ai-key: ${{ secrets.PROWL_AI_KEY }}
          config-path: .prowl-review.yml
          workspace-path: ${{ github.workspace }}/pr-head
```

## Local pre-push review (CLI)

Run the **same** review engine against a local git diff before you open a PR —
no GitHub token, no posting (#35). Findings print to the terminal:

```bash
# Review your branch's changes against main (tracked uncommitted edits included)
PROWL_AI_KEY=sk-… prowl-review review --base main

# Review the checked-out branch as an explicit head ref
PROWL_AI_KEY=sk-… prowl-review review --base main --head my-feature
```

The diff is taken relative to the **merge base** of `--base` and `--head` (PR
semantics — only the changes your branch introduces). Omit `--head` to review
the working tree. Untracked files are not part of Git's working-tree diff, so
local mode fails with a clear prompt to stage or commit them before review. When
`--head` is supplied, it must resolve to the currently checked-out `HEAD` and the
worktree must be clean; the later context, guidelines, grounding, and secret
scans read from that local checkout. Passing `--base` (or `--head`) switches the
`review` command into local mode; the GitHub flags (`--pr`, `--repo`,
`--dry-run`) are ignored.

| Flag | Effect |
|------|--------|
| `--base <ref>` | Base ref to diff against (default `main`). |
| `--head <ref>` | Checked-out head ref (default: the working tree). |
| `--min-severity <sev>` | Drop findings below this severity. |
| `--no-context` / `--no-grounding` / `--no-verify` | Skip cross-file context (#4), linter/SAST grounding (#16), or the false-positive pass (#8). |
| `--trust-workspace` | Allow repo-local linter/SAST code to execute. Without this or `PROWL_TRUST_WORKSPACE=true`, repo-local execution stays disabled. |
| `--json` | Print findings as JSON (for tooling) instead of the human report. |
| `--no-color` | Disable ANSI color (also honors `NO_COLOR`). |
| `--fail-on <sev>` | Exit non-zero when a finding at/above this severity is found — wire it into a pre-push hook as a gate. |

The same agentic cross-file context and safe linter/SAST grounding run over the
git repository top-level. Repo-local linter code executes only with
`--trust-workspace` or `PROWL_TRUST_WORKSPACE=true`; per-run cost prints to
stderr so `--json` stdout stays clean.

## Multi-provider ensemble (#53)

A BYOK-only edge: review the same changes with **more than one provider at once**
and consolidate their findings, so you get cross-model consensus and
higher-confidence, more granular insight — something resale-based reviewers
(CodeRabbit/Greptile) can't offer. Opt-in, default off.

Give each provider its **own** key — the cleanest setup, with no dependence on
which provider the generic key maps to. Locally (or any runner), set them as env
vars (the provider matching your primary also falls back to `PROWL_AI_KEY`; if
both are set, the scoped key wins):

```bash
PROWL_AI_KEY_ANTHROPIC=sk-ant-…
PROWL_AI_KEY_GEMINI=…
```

In the **GitHub Action**, pass them through the per-provider inputs (each maps to
the matching `PROWL_AI_KEY_<PROVIDER>` env var):

```yaml
- uses: prowl-tools/prowl-code-review@v1
  with:
    ai-key-anthropic: ${{ secrets.PROWL_AI_KEY_ANTHROPIC }}
    ai-key-gemini:    ${{ secrets.PROWL_AI_KEY_GEMINI }}
    # ai-key-openai:  ${{ secrets.PROWL_AI_KEY_OPENAI }}
    config-path: prowl-review-config/.prowl-review.yml   # trusted base-branch config
```

…and list the providers in `.prowl-review.yml` (the first listed provider is the
**primary** — it runs the shared cross-file context retrieval, so put your
strongest model there):

```yaml
provider: anthropic        # primary (also used for the shared context pass)
ensemble:
  enabled: true
  providers:
    - provider: anthropic
    - provider: gemini
      # model: gemini-2.5-pro   # optional per-provider model override
```

Each provider runs the full multi-pass review **in parallel**; the cross-file
context (#4) and linters (#16) run **once** and are shared. A judge then
consolidates findings across providers, recording provenance and **boosting
confidence on agreement** — agreement can even rescue a finding each provider
scored just under the threshold (it complements the false-positive pass, #8).
Consolidated findings carry a **🤝 N/M consensus badge** in the summary and an
inline note naming the agreeing providers; single-provider findings are kept and
attributed to the model that raised them.

**Two perspectives, one comment.** When more than one model flags the same issue,
the inline comment keeps *each model's own take* in a collapsible **🔀 N model
perspectives** block — every provider's severity, confidence, and reasoning side
by side — so you get cross-model insight in the PR without running multiple tools.
The top-line comment stays the strongest representative; expand the block to
compare how each model saw it.

**Cost:** roughly **N× a single-provider review** (caching helps within each
provider, not across). The per-PR budget cap (#18) is **split evenly** across
providers, and risk-tiering (#31) still applies. A provider with no key is
skipped with a note; with fewer than two usable keys it runs as a normal
single-provider review.

## Auto-generated PR descriptions (#33)

When a pull request is opened with an **empty description**, prowl-review can
write one from the diff — CodeRabbit-style — so reviewers get a plain-language
summary of what changed. Opt-in:

```yaml
# .prowl-review.yml
prDescription:
  enabled: true
```

The generated summary is written into the PR body between
`<!-- prowl-review:pr-summary:start -->` / `…:end -->` markers, so later pushes
refresh it in place while preserving anything you add around it. A
**human-authored description is never overwritten** — it only fires on an empty
body (or to refresh prowl-review's own block). Needs `pull-requests: write`
(already required to post reviews).

## Issue / ticket validation (#32)

When a PR **links a GitHub issue**, prowl-review pulls the issue's acceptance
criteria and flags anything the diff doesn't satisfy — so scope gaps are caught
in review. Opt-in:

```yaml
# .prowl-review.yml
issueValidation:
  enabled: true
  # maxIssues: 3   # cap linked issues fetched per PR (default 3)
```

It recognizes the references GitHub treats as links: a **closing keyword**
(`Closes #12`, `Fixes owner/repo#5`) or an **issue URL** in the PR title/body. A
dedicated *requirements* review lens receives the issue's criteria and raises a
finding for each one the PR misses or only partially implements — so the gaps
appear inline alongside the normal review (and, in an ensemble, get cross-model
consensus too). Fetching is tolerant: a missing or inaccessible issue (or one
that's actually a PR) is skipped with a note. Cross-tracker support
(Linear/Jira) is a future extension.

## Development

```bash
npm install
npm run build   # tsup → dist/ (CLI + library)
npm run lint    # eslint
npm test        # vitest
```

The CLI entry point is `dist/cli.js` (bin: `prowl-review`):

```bash
node dist/cli.js --help
```

### Quality benchmark

Score the reviewer against the in-repo benchmark of PRs-with-known-bugs to
measure precision/recall/F1 and the clean-PR false-alarm rate (needs
`PROWL_AI_KEY`):

```bash
node dist/cli.js eval            # scores ./bench, prints a summary
```

See [`docs/eval.md`](docs/eval.md) for details and [`bench/README.md`](bench/README.md) for the case format.

## License

Apache-2.0 — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
