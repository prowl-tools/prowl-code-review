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

# Cancel a superseded review when new commits land on the same PR, so rapid
# re-pushes don't spawn overlapping reviews racing to comment (#21). prowl-review
# also re-checks the PR head before publishing and skips if it advanced, so a
# just-cancelled run can't post stale results for an outdated commit.
concurrency:
  group: prowl-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

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
number with `cancel-in-progress` means an in-flight review for an outdated commit
is cancelled cleanly when you push again.

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

Commands need a second workflow listening for comments:

```yaml
# .github/workflows/prowl-review-command.yml
name: prowl-review command
on:
  issue_comment:
    types: [created]
permissions:
  pull-requests: write
  issues: write
  contents: read
jobs:
  command:
    if: github.event.issue.pull_request && contains(github.event.comment.body, '@prowl-review')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: prowl-tools/prowl-code-review@v1
        with:
          mode: command
          ai-key: ${{ secrets.PROWL_AI_KEY }}
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
