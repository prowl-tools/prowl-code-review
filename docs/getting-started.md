# Getting started

`prowl-review` is a **BYOK (bring-your-own-key) AI code reviewer** for pull
requests. It posts a walkthrough summary, inline findings with committable
suggestions, and answers `@prowl-review` chat — using **your own** LLM key.
Because you pay the provider directly, there are no usage caps imposed by the
tool.

- **Bring your own key.** Claude (default), OpenAI, or Gemini. Or run
  **keyless** through a ChatGPT subscription with `provider: codex` on your own
  hardware — see [Auth](auth.md) and [Self-hosted runner](self-hosted-runner.md).
- **Quality-first, not diff-only.** Multi-pass specialist review + judge/dedup,
  agentic cross-file context, linter/SAST grounding, and a skeptical
  false-positive verification pass — see the guides.
- **Zero hosting.** Ships as a GitHub Action + a local CLI. Your code only ever
  goes to your chosen provider — see [Privacy](privacy.md).

> `prowl-review` is maintained as an internal tool. It is published on npm and
> public on GitHub, and gets dependency/security updates and breakage fixes, but
> no new feature work.

## Quickstart (GitHub Action)

1. Add your provider key as a repository secret named **`PROWL_AI_KEY`**
   (Settings → Secrets and variables → Actions).
2. Add the workflow:

```yaml
# .github/workflows/prowl-review.yml
name: prowl-review
on:
  pull_request:
    types: [opened, synchronize, ready_for_review, reopened]

# Serialize auto reviews with bot commands for the same PR so command side
# effects aren't interrupted when new commits arrive.
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
    # Forks don't receive provider secrets.
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: prowl-tools/prowl-code-review@v1
        with:
          ai-key: ${{ secrets.PROWL_AI_KEY }}
```

3. Open a pull request — prowl-review posts a walkthrough summary and inline
   findings, and updates them in place on each push.

Copy-paste starters (auto-review, command, branded-bot, and self-hosted Codex
variants) live in [`examples/workflows/`](../examples/workflows/). Rolling out
across a whole org? Use the reusable
[`workflow_call` templates](github-action.md#reusable-org-workflow) so each repo
opts in with a few lines.

## Configure it

Everything works with defaults and no config file. To tune the review, scaffold
a commented `.prowl-review.yml`:

```bash
prowl-review init
```

See [Configuration](configuration.md) for every key. In the Action, repo config
is only honored when you pass a trusted `config-path` — see
[Trusted config](github-action.md#trusted-config).

## Local pre-push review

The same engine runs locally against a git diff before you push — no GitHub
token, no posting. Findings print to the terminal:

```bash
npm install -g prowl-review          # or: brew install prowl-tools/tap/prowl-review
PROWL_AI_KEY=sk-… prowl-review review --base main
```

See the [CLI](cli.md) reference.

## Next steps

| Page | What's in it |
|---|---|
| [GitHub Action](github-action.md) | Inputs, permissions, drafts, forks, check run, reusable org workflow. |
| [Configuration](configuration.md) | Every `.prowl-review.yml` key. |
| [Bot commands](bot-commands.md) | `@prowl-review review`, `ignore`, `resolve`, `configure`, and chat. |
| [Cross-file context](cross-file-context.md) | The agentic retrieval tools and their guards. |
| [Grounding](grounding.md) | ESLint / Ruff / Gitleaks / Semgrep / osv-scanner signals. |
| [Ensemble](ensemble.md) | Review with two providers at once and merge the findings. |
| [Auth](auth.md) · [Privacy](privacy.md) | Keys, token scopes, and what leaves the runner. |
| [Example review](example-review.md) | A rendered sample walkthrough. |
