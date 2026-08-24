# CLAUDE.md — Prowl Review (prowl-code-review)

> Workspace-wide conventions (mission, branding, repo map, stack baseline, Definition of Done,
> git/backlog policy) live in the **workspace `CLAUDE.md`** (`../../CLAUDE.md`) and load
> automatically. This file covers only what is specific to `prowl-code-review`.

## Project Context
**Prowl Review** is a **BYOK (bring-your-own-key) AI code-review tool** — the code-review pillar
of the Prowl family. It reviews pull requests (summary + inline comments + `@prowl-review` chat)
using the developer's own LLM key, with no usage caps imposed by us. Package/command name:
`prowl-review`.

It exists because commercial reviewers (CodeRabbit, Greptile) resell LLM inference under a flat
subscription and therefore **must** rate-limit to protect margins. Prowl Review flips the model:
the **user's key pays the provider directly**, so we carry near-zero marginal cost and never cap
usage — the only ceiling is the user's own provider limits. This directly embodies the workspace
mission (self-sovereign data, model choice, no metered lock-in).

- **Delivery (Phase 1):** a TypeScript CLI core + a thin GitHub Action wrapper. Zero hosting.
- **Delivery (Phase 2, deferred):** an optional hosted GitHub App wrapping the same TS core.
- **Local mode:** the same CLI runs locally for pre-push review.

## Core Principles
1. **Free forever, BYOK.** Never resell inference or meter usage. Users supply `PROWL_AI_KEY`.
2. **Provider-agnostic, with caching.** Multi-provider abstraction — Claude (default), OpenAI,
   Gemini — via `PROWL_AI_PROVIDER`. Reuse the pattern in `prowl-tools/prowl` at
   `src/generator/ai.ts` (raw `fetch`, no heavy SDKs). Use **prompt caching** for stable content
   (system prompt, guidelines, fetched repo context, tool defs); only the diff is uncached.
3. **Quality-first, cost-managed — NOT diff-only.** A single-pass, diff-only review is exactly
   the experience we're beating; the quality comes from the differentiators below. Manage cost
   via prompt caching + risk-tiered orchestration, not by stripping them. Per-review stays in cents.
4. **Whole-repo context via AGENTIC retrieval, never a vector DB.** Give the review agent
   grep/read tools to pull callers, callees, and related files on demand — cheaper and more
   accurate than embeddings/RAG.
5. **No silent truncation.** When caps (`maxFiles`/`maxDiffBytes`/context limits) skip content,
   report it in the review rather than dropping it silently.
6. **Made for agents, controlled by humans.** Safe to run on agent-generated PRs without runaway cost.

## The Differentiators (first-class, not polish)
1. **Agentic cross-file context** — the #1 lever; catches broken callers, contract violations,
   inconsistent patterns.
2. **Multi-pass specialized review + judge/dedup** — parallel lenses (correctness/security/perf/
   tests) merged and de-duplicated by a judge pass.
3. **Linter/SAST grounding** — ESLint/Ruff/Semgrep/Gitleaks fed in as signals.
4. **False-positive verification** — a skeptical second pass + confidence scoring + severity
   threshold for high-signal output.

Also tracked in the backlog: multi-language (tree-sitter), a quality eval harness
(precision/recall), review state persistence, and LLM resilience / per-PR budget cap.

## Presentation Conventions (premium feel = free GitHub API features)
- **One cohesive published review**: a single `POST /pulls/{n}/reviews` with `event: COMMENT`, a
  summary `body`, and `comments[]` (or an explicit submit-review step).
- **Walkthrough summary**: plain-language summary, Impact + estimated-effort badges, grouped
  changed-files overview, severity counts; optional **Mermaid** diagram.
- **Inline findings** carry a **severity badge** (Critical/Major/Minor/Trivial/Info) + a
  committable ```suggestion``` block when a safe fix exists.
- **Update, don't duplicate**: on re-run, identify the prior review by a prowl-specific marker or
  stored review id (not author alone), update via `PUT .../reviews/{review_id}`, resolve outdated
  threads via GraphQL `resolveReviewThread`, and review only the delta on `synchronize`.
- **Optional merge gate** via the Checks API (`conclusion` from max severity + line annotations).
- Sample workflow token needs: `pull-requests: write`, `checks: write`, `contents: read`.

## Repo-specific Stack notes
(Shared baseline — TS/ESM/tsup/Vitest/ESLint — is in the workspace file; these are the extras.)
- **CLI:** Commander. **Validation/schema:** Zod. **YAML:** `yaml`.
- **GitHub integration:** `@actions/core` + `@actions/github` (Octokit) for diff fetch and posting
  reviews; inline comments via `POST .../reviews` with `event: COMMENT` and a `comments[]` array
  (`path` + `line` + `side`) mapped from diff hunk positions.
- **Action auth:** auto-provisioned `GITHUB_TOKEN` (`pull-requests: write`) for posting;
  `PROWL_AI_KEY` secret for the provider.
- **Config:** `.prowl-review.yml`, Zod-validated (style of `prowl/src/config/schema.ts`).

## Distribution (when we ship — backlog items 42-43)
- **npm**: publish `prowl-review` (mirror `prowl`'s CI tag-triggered publish workflow).
- **Homebrew**: add `Formula/prowl-review.rb` to `prowl-tools/homebrew-tap` (pins the npm tarball
  `url` + `sha256`; `depends_on node@20`).
- **Docs/marketing**: add pages to `prowl-code-review-docs` (review.prowl.tools) and a section +
  install snippet to `prowl-web`.

## Existing Workflows
This repo dogfoods its own tool: `.github/workflows/prowl-review.yml` (auto review on PRs) and
`prowl-review-command.yml` (`@prowl-review` chat/commands) run against every PR on the self-hosted
Mac mini runner (`runs-on: [self-hosted, macOS, prowl-review]`) using the keyless Codex
subscription provider (`provider: codex`, #45/#64) — subscription-backed, $0.00/review, with no
provider secret in GitHub. The Claude + Gemini ensemble (#53) it replaced is kept as a commented,
key-gated fallback in `.prowl-review.yml`. The placeholder `anthropics/claude-code-action`
workflows were retired once prowl-review reached parity (#44) — prowl-review replaces the baseline
reviewer and `@prowl-review` replaces the `@claude` assistant, so the repo is prowl-review-only.
