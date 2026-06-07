# prowl-review

**BYOK (bring-your-own-key) AI code review for pull requests** — the code-review pillar of the [Prowl QA](https://prowl.tools) suite.

`prowl-review` reviews pull requests (summary + inline comments + `@prowl-review` chat) using your **own** LLM key — Claude (default), OpenAI, or Gemini — with **no usage caps imposed by us**. Because your key pays the provider directly, there's nothing to rate-limit: the only ceiling is your provider's own limits, which dwarf the per-hour caps of commercial reviewers.

It's delivered as a **GitHub Action + local CLI** (zero hosting), and is built to match — not just approximate — the quality of CodeRabbit/Greptile via agentic cross-file context, multi-pass specialized review, linter/SAST grounding, and false-positive verification.

> Status: **early development.** This package currently contains the project scaffold and CLI surface. See [`docs/backlog.md`](docs/backlog.md) for the roadmap and [`CLAUDE.md`](CLAUDE.md) for the design principles.

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

## License

Apache-2.0 — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
