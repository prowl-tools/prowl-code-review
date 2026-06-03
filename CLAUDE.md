# CLAUDE.md - Agent Guidelines for prowl-review

## Project Context

`prowl-review` is a **BYOK (bring-your-own-key) AI code-review tool** — the code-review pillar of the Prowl QA suite. It reviews pull requests (summary + inline comments + `@prowl-review` chat) using the developer's own LLM key, with no usage caps imposed by us.

It exists because commercial reviewers (CodeRabbit, Greptile) resell LLM inference under a flat subscription and therefore **must** rate-limit to protect margins (CodeRabbit's own blog: rate-limiting saved ~20% of cost; their per-hour caps cascade from their upstream OpenAI/Anthropic limits). `prowl-review` flips the model: the **user's key pays the provider directly**, so we carry near-zero marginal cost per review and never need to cap usage. The only ceiling is the user's own provider rate limits — which dwarf CodeRabbit's 5/hr.

- **Delivery (Phase 1):** a TypeScript CLI core + a thin GitHub Action wrapper. Zero hosting.
- **Delivery (Phase 2, deferred):** an optional hosted GitHub App (install-once) wrapping the same TS core.
- **Local mode:** the same CLI runs locally for pre-push review.

## Core Principles

1. **Free forever, BYOK.** We never resell inference or meter usage. Users supply `PROWL_AI_KEY`. No rate limits originate from us.
2. **Provider-agnostic, with caching.** Multi-provider abstraction — Claude (default), OpenAI, Gemini — selected via `PROWL_AI_PROVIDER`. Reuse the pattern in `Prowl-qa/prowl` at `src/generator/ai.ts` (raw `fetch`, no heavy SDKs; consistent env-var names). Use **prompt caching** for stable content (system prompt, guidelines, fetched repo context, tool defs); only the diff is uncached.
3. **Quality-first, cost-managed — NOT diff-only.** A single-pass, diff-only review is exactly the Claude Code / Codex experience we're trying to beat; do not ship that. The bug-catching quality comes from the differentiators below. Manage cost not by stripping them out, but via **prompt caching** + **risk-tiered** orchestration (fewer passes on small diffs). Per-review stays in cents.
4. **Whole-repo context via AGENTIC retrieval, never a vector DB.** Give the review agent grep/read tools to pull callers, callees, and related files on demand. This is cheaper and more accurate than embeddings/RAG (the modern agentic-reviewer consensus) and avoids the indexing infrastructure that balloons cost.
5. **No silent truncation.** When caps (`maxFiles`/`maxDiffBytes`/context fetch limits) skip content, report it in the review rather than dropping it silently.
6. **Match `prowl`'s engineering.** Same toolchain and conventions so the suite stays cohesive (see below).
7. **Made for agents, controlled by humans.** Suite-wide framing; safe to run on agent-generated PRs without runaway cost.

## The Differentiators (the reason to build, not just tune Claude Code's review)

These are first-class, not polish. Stripping them yields a tool no better than what already exists.

1. **Agentic cross-file context** — the #1 lever. Catches broken callers, contract/interface violations, inconsistent patterns. (backlog: *Agentic cross-file context retrieval*)
2. **Multi-pass specialized review + judge/dedup** — parallel lenses (correctness/security/perf/tests) merged and de-duplicated by a judge pass into one clean result. (backlog: *Multi-pass specialized review + judge/dedup*)
3. **Linter/SAST grounding** — ESLint/Ruff/Semgrep/Gitleaks fed in as signals to catch deterministic issues and curb hallucination. (backlog: *Linter / SAST grounding*)
4. **False-positive verification** — a skeptical second pass + confidence scoring + severity threshold, so output is high-signal. (backlog: *False-positive verification pass*)

Cross-cutting parity work also tracked in the backlog: **multi-language** (tree-sitter; not JS/TS-only), a **quality eval harness** (precision/recall to prove parity), **review state persistence** (stateless-Action store underpinning incremental review + learnings), and **LLM resilience / per-PR budget cap**.

## Presentation Conventions (premium feel = free GitHub API features)

- **One cohesive published review**, not scattered comments: a single `POST /pulls/{n}/reviews` with `event: COMMENT`, a summary `body`, and `comments[]` (or an explicit submit-review step after creating a pending review).
- **Walkthrough summary**: plain-language summary, Impact + estimated-effort badges, grouped/layered changed-files overview, severity counts; optional **Mermaid** diagram for clear flows.
- **Inline findings** carry a **severity badge** (Critical/Major/Minor/Trivial/Info) + a committable ```suggestion``` block when a safe fix exists.
- **Update, don't duplicate**: on re-run, update the prior bot review summary via REST `PUT /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}` or the matching GraphQL mutation, then resolve outdated threads with GraphQL `resolveReviewThread`; review only the delta on `synchronize`.
- **Optional merge gate** via the Checks API (`conclusion` from max severity + line annotations).
- Sample workflow token needs: `pull-requests: write`, `checks: write`, `contents: read`.

## Stack & Conventions (mirror `Prowl-qa/prowl`)

- **Language:** TypeScript, ESM (`"type": "module"`), strict `tsconfig`.
- **CLI:** Commander. **Validation/schema:** Zod. **YAML:** `yaml`. **Build:** tsup (ESM+CJS). **Tests:** Vitest. **Lint:** ESLint + `@typescript-eslint`.
- **GitHub integration:** `@actions/core` + `@actions/github` (Octokit) for diff fetch and posting reviews. Inline comments via REST `POST /repos/{owner}/{repo}/pulls/{n}/reviews` with `event: COMMENT` and a `comments[]` array (`path` + `line` + `side`), mapped from diff hunk positions.
- **Action auth:** auto-provisioned `GITHUB_TOKEN` (needs `pull-requests: write`) for posting; `PROWL_AI_KEY` secret for the provider.
- **Config:** `.prowl-review.yml`, Zod-validated (style of `prowl/src/config/schema.ts`).
- **File naming:** kebab-case, except tool-mandated root files such as `CLAUDE.md`. **Package/command name:** `prowl-review`.
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

## Distribution (when we ship — see backlog items 42-43)

- **npm**: publish `prowl-review` (mirror `prowl`'s CI tag-triggered publish workflow).
- **Homebrew**: add `Formula/prowl-review.rb` to `Prowl-qa/homebrew-tap` (pulls the npm tarball; pins `url` + `sha256`; `depends_on node@20`).
- **Docs/marketing**: add a page to `prowl-docs` (+ sidebar entry) and a section/install snippet to `prowl-web`.

## Prowl QA Ecosystem

**GitHub Org**: [Prowl-qa](https://github.com/Prowl-qa)

| Repo | Purpose |
|------|---------|
| `Prowl-qa/prowl-code-review` | AI code-review tool (this repo) |
| `Prowl-qa/prowl` | Core CLI QA tool (source of truth for toolchain + provider abstraction) |
| `Prowl-qa/prowl-docs` | Documentation site (Docusaurus) |
| `Prowl-qa/prowl-web` | Marketing landing page (Next.js) |
| `Prowl-qa/prowl-hub` | Community hunt templates |
| `Prowl-qa/prowl-infra-hub` | IaC playbooks hub |
| `Prowl-qa/homebrew-tap` | Homebrew formulae |

### Cross-Repo Guidelines
- **`prowl`** is the reference for toolchain, lint/build config, and the LLM provider abstraction — reuse its patterns rather than inventing new ones.
- **prowl-docs** gets a `prowl-review` page when commands/config/behavior stabilize.
- **prowl-web** gets a feature section + install snippet when we ship publicly.

## Existing Workflows

This repo currently has placeholder Anthropic workflows (`.github/workflows/claude-code-review.yml`, `claude.yml`) from `anthropics/claude-code-action`. Keep them as a dogfooding baseline during early milestones; replace `claude-code-review.yml` with our own `prowl-review` action once inline reviews land (backlog item 10).

## Access Policy

Infrastructure credentials and host details are not stored in this repository.
