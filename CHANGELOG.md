# Changelog

All notable changes to Prowl Review will be documented in this file.

## [Unreleased]

### Added
- Inline comments + committable suggestions (`src/review/inline.ts`, `src/github/review.ts`):
  map ranked findings to GitHub review comments anchored on exact new-side diff lines
  (multi-line ranges supported), each with a severity badge and a committable `suggestion`
  block when a fix exists; findings that don't land on a changed line stay in the summary
  (no silent drop). `submitReview` publishes one cohesive review (`POST /pulls/{n}/reviews`)
  with the walkthrough body + `comments[]`. (backlog #10)
- Structured walkthrough summary (`src/review/walkthrough.ts`): a pure markdown formatter
  that renders the review summary body from ranked findings + the parsed diff — plain-language
  summary, Impact + estimated-effort badges (derived or overridable), severity counts, a
  changed-files overview grouped by directory with line deltas, blocking-findings highlights,
  a skipped-files note (no silent truncation), and an optional Mermaid diagram. Carries a
  stable marker for update-not-duplicate (#22). (backlog #9)
- Multi-pass specialized review + judge/dedup (`src/review/`): parallel specialist passes
  (correctness, security, performance, tests) — each tightly scoped with an explicit
  "what NOT to flag" section and an optional per-specialist model — run with trusted
  stable instructions in the shared system block and untrusted diff/context in the user
  prompt, then a deterministic judge dedupes (file+line+category), thresholds by severity,
  and ranks. Includes the Zod findings schema (severity + confidence) and tolerant JSON
  parsing. Specialist failures degrade gracefully and are reported. (backlog #6; also
  delivers #7's findings schema + prompts)
- Agentic cross-file context retrieval (`src/context/`): a sandboxed repo-access toolkit
  (read-file, regex grep, list — confined to the repo root, bounded, binary/ignored-dir
  aware) plus a provider-agnostic tool-use loop (`gatherContext`) where the model decides
  what to fetch (callers/definitions/related files) — no vector DB. Tool-use (function
  calling) is implemented for all three providers. Everything fetched, truncated, errored,
  or limited is reported, never dropped silently. (backlog #4)
- Diff fetch + parsing (`src/github/`, `src/review/`): fetch a PR's metadata and raw
  unified diff via Octokit (`@actions/github`), parse it into structured files/hunks/lines
  with old/new line numbers (the mapping inline comments will use), and apply `maxFiles`/
  `maxDiffBytes` size guards that report skipped/binary files instead of dropping them
  silently. (backlog #3)
- Multi-provider BYOK LLM abstraction (`src/providers/`): Claude (default), OpenAI, and
  Gemini behind one `complete()` interface, selected via `PROWL_AI_PROVIDER` / `PROWL_AI_KEY`
  / `PROWL_AI_MODEL` (raw `fetch`, no heavy SDKs). Prompt caching for the stable `system`
  prefix (Anthropic `cache_control`; OpenAI/Gemini automatic) with cache-aware token/usage
  accounting. (backlog #2)
- CI pipeline: `.github/workflows/ci.yml` runs `npm ci` → build → lint → test on every
  pull request and push to `main` (Node 20 matrix, npm dependency caching, concurrency
  cancellation). This is the repo's authoritative validation gate. (backlog #50)
- Initial TypeScript package scaffold mirroring `prowl`'s toolchain: ESM + strict
  `tsconfig`, `tsup` dual-entry build (CLI + library), ESLint + `@typescript-eslint`,
  and Vitest. Commander-based CLI (`prowl-review`) with a `--version`/`--help` surface
  and a placeholder `review` command. Apache-2.0 `LICENSE` + `NOTICE`. (backlog #1)
