# prowl-review

**BYOK (bring-your-own-key) AI code review for pull requests** — the code-review pillar of the [Prowl QA](https://prowl.tools) suite.

`prowl-review` reviews pull requests (summary + inline comments + `@prowl-review` chat) using your **own** LLM key — Claude (default), OpenAI, or Gemini — with **no usage caps imposed by us**. Because your key pays the provider directly, there's nothing to rate-limit: the only ceiling is your provider's own limits, which dwarf the per-hour caps of commercial reviewers.

It's delivered as a **GitHub Action + local CLI** (zero hosting), and is built to match — not just approximate — the quality of CodeRabbit/Greptile via agentic cross-file context, multi-pass specialized review, linter/SAST grounding, and false-positive verification.

> Status: **early development.** This package currently contains the project scaffold and CLI surface. See [`docs/backlog.md`](docs/backlog.md) for the roadmap and [`CLAUDE.md`](CLAUDE.md) for the design principles.

## Usage (GitHub Action)

Add a workflow that runs the review on pull requests. Store your provider key as
the `PROWL_AI_KEY` repository secret.

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
    # Skip drafts and fork PRs (forks don't receive provider secrets).
    if: github.event.pull_request.draft == false && github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: prowl-tools/prowl-code-review@v1
        with:
          ai-key: ${{ secrets.PROWL_AI_KEY }}
          # ai-provider: anthropic   # anthropic | openai | gemini (default anthropic)
          # ai-model: claude-...     # optional per-provider model override
```

The `concurrency` block is the recommended pattern: keying the group to the PR
number serializes auto reviews with bot commands. `queue: max` and
`cancel-in-progress: false` preserve maintainer-requested side effects such as
`pause`, `resume`, and `break glass`; stale queued auto reviews skip publishing
when the PR head has advanced.

### Bot commands

Drive the reviewer from the PR by commenting `@prowl-review <command>` (only a
repo owner/member/collaborator is honored):

| Command | Effect |
|---|---|
| `@prowl-review review` | Re-review the latest changes (incremental). |
| `@prowl-review full review` | Re-scan the entire PR from scratch. |
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
concurrency:
  group: prowl-review-${{ github.event.issue.number }}
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
      github.event.issue.pull_request &&
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
          base_sha="$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${{ github.event.issue.number }}" --jq '.base.sha')"
          head_sha="$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${{ github.event.issue.number }}" --jq '.head.sha')"
          head_repo="$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${{ github.event.issue.number }}" --jq '.head.repo.full_name')"
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
          workspace-path: ${{ github.workspace }}/pr-head
```

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
