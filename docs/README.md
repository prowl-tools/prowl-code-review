# prowl-review documentation

Documentation for `prowl-review`, the BYOK AI code reviewer. The
[repo README](../README.md) is the long-form overview; these pages are the
reference.

## Getting started

- [Getting started](getting-started.md) — what it is, the quickstart workflow, and local pre-push review.

## Reference

- [Configuration](configuration.md) — every `.prowl-review.yml` key and its default.
- [CLI](cli.md) — `review`, `command`, `init`, `costs`, `eval` and their flags.
- [Bot commands](bot-commands.md) — the `@prowl-review` verbs and per-PR overrides.

## Guides

- [GitHub Action](github-action.md) — inputs, permissions, trusted config, check run, drafts and forks.
- [Self-hosted runner](self-hosted-runner.md) — running keyless `provider: codex` reviews on your own runner.
- [Multi-provider ensemble](ensemble.md) — review with two providers at once and merge the findings.
- [Linter / SAST grounding](grounding.md) — ESLint, Ruff, Gitleaks, Semgrep, and osv-scanner signals.
- [Cross-file context](cross-file-context.md) — the agentic retrieval tools, their guards, and bounds.
- [Repo-wide learnings](repo-wide-learnings.md) — persisting `ignore`/`resolve` mutes across PRs, plus guidelines files.

## Policy

- [Authentication & keys](auth.md) — BYOK setup, provider keys, token scopes, bot identity, and the Codex provider.
- [Privacy & data handling](privacy.md) — what leaves your runner, what doesn't, and what's retained.

## What a review looks like

- [Example review](example-review.md) — a rendered sample walkthrough and inline comment.

## Maintainers

- [Releasing](releasing.md) — the npm release process.
- [Quality benchmark](eval.md) — scoring precision/recall/F1 against the in-repo benchmark.
- [Backlog](backlog.md) — open work items.
- [Resolved](resolved.md) — completed work items.
