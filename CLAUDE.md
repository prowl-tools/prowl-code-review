# CLAUDE.md - Agent Guidelines for prowl-review

## Project Context

`prowl-review` is a **BYOK (bring-your-own-key) AI code-review tool** — the code-review pillar of the Prowl QA suite. It reviews pull requests (summary + inline comments + `@prowl-review` chat) using the developer's own LLM key, with no usage caps imposed by us.

It exists because commercial reviewers (CodeRabbit, Greptile) resell LLM inference under a flat subscription and therefore **must** rate-limit to protect margins (CodeRabbit's own blog: rate-limiting saved ~20% of cost; their per-hour caps cascade from their upstream OpenAI/Anthropic limits). `prowl-review` flips the model: the **user's key pays the provider directly**, so we carry near-zero marginal cost per review and never need to cap usage. The only ceiling is the user's own provider rate limits — which dwarf CodeRabbit's 5/hr.

- **Delivery (Phase 1):** a TypeScript CLI core + a thin GitHub Action wrapper. Zero hosting.
- **Delivery (Phase 2, deferred):** an optional hosted GitHub App (install-once) wrapping the same TS core.
- **Local mode:** the same CLI runs locally for pre-push review.

## Core Principles

1. **Free forever, BYOK.** We never resell inference or meter usage. Users supply `PROWL_AI_KEY`. No rate limits originate from us.
2. **Provider-agnostic.** Multi-provider abstraction — Claude (default), OpenAI, Gemini — selected via `PROWL_AI_PROVIDER`. Reuse the pattern in `Prowl-qa/prowl` at `src/generator/ai.ts` (raw `fetch`, no heavy SDKs; consistent env-var names).
3. **Diff-focused, cost-lean MVP.** Review the PR diff (with context), not the whole codebase. Deliberately skip whole-repo embedding/vector-DB indexing and N-pass multi-agent pipelines in the MVP — that is exactly where commercial tools' (and our) costs balloon. Keep per-review cost in the pennies.
4. **No silent truncation.** When config caps (`maxFiles`/`maxDiffBytes`) skip content, report it in the review rather than dropping it silently.
5. **Match `prowl`'s engineering.** Same toolchain and conventions so the suite stays cohesive (see below).
6. **Made for agents, controlled by humans.** Suite-wide framing; the reviewer should be safe to run on agent-generated PRs without runaway cost.

## Stack & Conventions (mirror `Prowl-qa/prowl`)

- **Language:** TypeScript, ESM (`"type": "module"`), strict `tsconfig`.
- **CLI:** Commander. **Validation/schema:** Zod. **YAML:** `yaml`. **Build:** tsup (ESM+CJS). **Tests:** Vitest. **Lint:** ESLint + `@typescript-eslint`.
- **GitHub integration:** `@actions/core` + `@actions/github` (Octokit) for diff fetch and posting reviews. Inline comments via REST `POST /repos/{owner}/{repo}/pulls/{n}/reviews` with a `comments[]` array (`path` + `line` + `side`), mapped from diff hunk positions.
- **Action auth:** auto-provisioned `GITHUB_TOKEN` (needs `pull-requests: write`) for posting; `PROWL_AI_KEY` secret for the provider.
- **Config:** `.prowl-review.yml`, Zod-validated (style of `prowl/src/config/schema.ts`).
- **File naming:** kebab-case. **Package/command name:** `prowl-review`.
- **License:** Apache-2.0 (LICENSE + NOTICE), consistent with the suite.

## Definition of Done

Every feature or bug fix must include:
1. **Code** — implementation with types, Zod schemas, and the relevant module (providers / github / review / config) as applicable.
2. **Tests** — Vitest unit tests covering the new behavior; all existing tests pass.
3. **Build & Lint** — `npm run build` and `npm run lint` pass.
4. **Changelog** — add the change to the `[Unreleased]` section in `CHANGELOG.md` (once it exists).

Work is not complete until all four are done.

## Backlog Management

This project's backlog is tracked at: `docs/backlog.md`

When you complete work that corresponds to a backlog item:
- Read the backlog file and find the matching item
- Move it to the `## Completed` section with the date: `(completed: YYYY-MM-DD)`
- Re-number remaining items if needed

When you discover new bugs, tech debt, or feature opportunities:
- Read the backlog file
- Add the item to the appropriate priority tier (High / Medium / Low)
- Use the existing format: numbered, bold title, indented description (user-story form: *As a `<role>`, I want… so that…* with acceptance criteria)

## Distribution (when we ship — see backlog items 14–15)

- **npm**: publish `prowl-review` (mirror `prowl`'s CI tag-triggered publish workflow).
- **Homebrew**: add `Formula/prowl-review.rb` to `Prowl-qa/homebrew-tap` (pulls the npm tarball; pins `url` + `sha256`; `depends_on node@20`).
- **Docs/marketing**: add a page to `prowl-docs` (+ sidebar entry) and a section/install snippet to `prowl-web`.

## Prowl QA Ecosystem

**GitHub Org**: [Prowl-qa](https://github.com/Prowl-qa)

| Repo | Purpose | Local Path |
|------|---------|------------|
| `Prowl-qa/prowl-code-review` | AI code-review tool (this repo) | `~/Desktop/Current Projects/Prowl QA/Repositories/prowl-code-review` |
| `Prowl-qa/prowl` | Core CLI QA tool (source of truth for toolchain + provider abstraction) | `~/Desktop/Current Projects/Prowl QA/Repositories/prowl` |
| `Prowl-qa/prowl-docs` | Documentation site (Docusaurus) | `~/Desktop/Current Projects/Prowl QA/Repositories/prowl-docs` |
| `Prowl-qa/prowl-web` | Marketing landing page (Next.js) | `~/Desktop/Current Projects/Prowl QA/Repositories/prowl-web` |
| `Prowl-qa/prowl-hub` | Community hunt templates (Next.js) | `~/Desktop/Current Projects/Prowl QA/Repositories/prowl-hub` |
| `Prowl-qa/prowl-infra-hub` | IaC playbooks hub (Next.js) | `~/Desktop/Current Projects/Prowl QA/Repositories/prowl-infra-hub` |
| `Prowl-qa/homebrew-tap` | Homebrew formulae | `~/Desktop/Current Projects/Prowl QA/Repositories/homebrew-tap` |

### Cross-Repo Guidelines
- **`prowl`** is the reference for toolchain, lint/build config, and the LLM provider abstraction — reuse its patterns rather than inventing new ones.
- **prowl-docs** gets a `prowl-review` page when commands/config/behavior stabilize.
- **prowl-web** gets a feature section + install snippet when we ship publicly.

## Existing Workflows

This repo currently has placeholder Anthropic workflows (`.github/workflows/claude-code-review.yml`, `claude.yml`) from `anthropics/claude-code-action`. Keep them as a dogfooding baseline during early milestones; replace `claude-code-review.yml` with our own `prowl-review` action once inline reviews land (backlog item 16).

## Access Policy

Infrastructure credentials and host details are not stored in this repository.
