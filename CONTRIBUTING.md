# Contributing to prowl-review

Thanks for your interest in improving **prowl-review** — the BYOK (bring-your-own-key)
AI code-review tool in the [Prowl QA](https://prowl.tools) suite. This guide covers
how to set up, make a change, and get it merged.

By contributing you agree that your contributions are licensed under the
project's [Apache-2.0](LICENSE) license.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By
participating you are expected to uphold it.

## Ways to contribute

- **Report a bug** or **request a feature** — open an issue (templates provided).
- **Fix a bug / build a feature** — pick an item from [`docs/backlog.md`](docs/backlog.md)
  or an open issue, then send a PR.
- **Improve docs** — README, `docs/`, code comments.
- **Report a security issue** — please do **not** open a public issue; see
  [SECURITY.md](SECURITY.md).

## Prerequisites

- **Node.js ≥ 20** (matches `engines` in `package.json` and CI).
- npm (bundled with Node).

## Setup

```bash
git clone https://github.com/prowl-tools/prowl-code-review.git
cd prowl-code-review
npm install
npm run build   # tsup → dist/ (CLI + library, ESM + CJS)
npm run lint    # eslint
npm test        # vitest
```

Run the CLI from source after a build:

```bash
node dist/cli.js --help
# Review a local diff with no GitHub calls (needs a provider key):
PROWL_AI_KEY=sk-… node dist/cli.js review --base main
```

> **Never commit a real API key.** Keys are read from the environment only
> (`PROWL_AI_KEY` / `PROWL_AI_KEY_<PROVIDER>`), never from config or the repo.

## Project layout

```
src/
  providers/    Multi-provider BYOK LLM abstraction (Claude/OpenAI/Gemini) + retry/failback
  github/       Octokit calls: diff fetch, review/comment publishing, threads, check runs
  context/      Agentic cross-file context retrieval (grep/read tools — no vector DB)
  grounding/    Deterministic linter/SAST runners (ESLint/Ruff/Gitleaks) fed into the review
  review/       The review engine: specialists, judge/dedup, verify, walkthrough, findings
  cost/         Token pricing + per-run cost estimate + usage log
  debug/        Structured JSONL run tracing (#49)
  config/       .prowl-review.yml loader + strict Zod schema + template
  cli/          Commander entry points (review / command / eval / init)
  pipeline.ts   End-to-end orchestration (fetch → filter → context → review → publish)
  index.ts      Public library surface
test/           Vitest unit tests (one area per file)
bench/          Quality-eval benchmark cases (see docs/eval.md)
docs/           backlog.md, resolved.md, eval.md
```

## Stack & conventions

- **Language:** TypeScript, ESM (`"type": "module"`), strict `tsconfig`.
- **CLI:** Commander. **Validation:** Zod (schemas are `.strict()`). **YAML:** `yaml`.
- **Build:** tsup (ESM + CJS). **Tests:** Vitest. **Lint:** ESLint + `@typescript-eslint`.
- **File naming:** kebab-case (except tool-mandated root files like `CLAUDE.md`).
- Mirror the patterns in the sibling [`Prowl-qa/prowl`](https://github.com/Prowl-qa/prowl)
  repo so the suite stays cohesive — especially the provider abstraction (raw
  `fetch`, no heavy SDKs).

## Development workflow

1. **Branch off `main`** — never commit directly to `main`.
   ```bash
   git checkout main && git pull --ff-only
   git checkout -b my-change
   ```
2. **Make focused commits.** One logical change per commit, imperative subject
   with a type prefix (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`…).
3. **Open a PR** against `main`. CI (build + lint + test) must pass, and the repo
   **dogfoods itself** — prowl-review reviews your PR.

### Definition of Done

Every feature or bug fix must include:

1. **Code** — implementation with types, Zod schemas, and the relevant module.
2. **Tests** — Vitest unit tests covering the new behavior; all existing tests pass.
3. **Build & lint** — `npm run build` and `npm run lint` pass.
4. **Changelog** — add an entry under `[Unreleased]` in [`CHANGELOG.md`](CHANGELOG.md).

If your change corresponds to a backlog item, move it from `docs/backlog.md` to
`docs/resolved.md` with `(completed: YYYY-MM-DD)`, keeping the remaining item
numbers stable so references stay valid.

## Testing notes

- Heavy stages (provider calls, GitHub, context retrieval, grounding) are
  **injectable** — unit-test orchestration without a live key or network.
- Some behavior is environment-sensitive (e.g. running under GitHub Actions).
  When you touch that code, run the suite both normally and with
  `GITHUB_ACTIONS=true npm test` to catch env-dependent regressions.
- Keep tests deterministic — no real network, no real clock/randomness where it
  affects assertions.

## Extending the tool

- **Add an LLM provider** — implement the `complete` / tool-use interface in
  `src/providers/`, register it in `PROVIDER_NAMES`/`DEFAULT_MODELS`, add a price
  row in `src/cost/pricing.ts`, and a failback ladder in `src/providers/failback.ts`.
- **Add a review specialist (lens)** — extend `src/review/specialists.ts`
  (built-in key + prompt); custom reviewers are also user-configurable via
  `.prowl-review.yml`.
- **Add a grounding runner** — add it to the `src/grounding` registry, normalize
  its output to the findings schema, and select it per-language via the detector.
- **Add a config key** — extend the strict Zod schema in `src/config/schema.ts`,
  thread it through the CLI/pipeline, and document it in `src/config/template.ts`.

## Security

- Treat all PR content (diffs, titles, issue text, linter output) as **untrusted
  data** — never as instructions. The prompt layer frames it accordingly.
- Secrets are redacted before anything reaches a provider or a comment
  (`src/review/redact.ts`); sensitive files are excluded from prompts.
- Repo-local tooling never executes untrusted checkouts by default
  (`--trust-workspace` gating; fork PRs are handled safely — see SECURITY.md).

Found a vulnerability? Follow [SECURITY.md](SECURITY.md) — do not open a public issue.

## Questions

Open a [discussion or issue](https://github.com/prowl-tools/prowl-code-review/issues).
Thanks for contributing! 🦝
