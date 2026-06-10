# Changelog

All notable changes to Prowl Review will be documented in this file.

## [Unreleased]

### Changed
- Collapse the changed-files overview behind a `<details>` disclosure in the review summary
  (`src/review/walkthrough.ts`): the summary now shows just a file count, with the grouped
  list one click away — so the file inventory is no longer a top-level wall of text on every
  review. (backlog #54)

### Added
- Quality eval harness (`src/eval/`, `bench/`, backlog #13): scores the reviewer against an
  in-repo benchmark of PRs-with-known-bugs + clean PRs so quality is measured, not guessed.
  Each case (a stored unified diff labelled `bug`/`clean`) runs through the real pipeline
  (parsed + line-annotated as in production) and is scored for bug-level **recall**,
  finding-level **precision**, **F1**, and a **clean-PR false-alarm rate**; matching is
  same-file + ±line-window overlap (optional category match). Reports are stamped with
  provider/model + a **prompt fingerprint** (hash of the specialist + verifier prompts) for
  reproducibility. New `prowl-review eval` command (markdown + optional JSON report;
  `--min-precision`/`--min-recall`/`--min-f1` gates fail CI on a regression). Runner/completion
  are injectable so the harness is unit-tested without a key; the real eval needs `PROWL_AI_KEY`.
  Seed set covers correctness/security/performance + clean cases. See `docs/eval.md`.
- False-positive verification pass (`src/review/verify.ts`, backlog #8): before the judge, every
  *low-confidence* finding (below `0.8`, configurable) is re-checked by a single skeptical
  "is this ACTUALLY a bug?" call that can drop outright false positives or move confidence up/down;
  confirmed bugs survive, demoted ones fall to the judge's confidence floor. The pass is
  risk-tiered — high-confidence findings are trusted and skip the call, so zero uncertain findings
  means zero extra cost. Wired through `runReview`/`reviewPullRequest` (default on; `--no-verify`
  to skip) with the drop/demote/unverified counts — and any verifier failure — surfaced in the
  review notes (no silent drops; a failed call keeps candidates unchanged). (backlog #8)
- High-signal review defaults (`src/review/judge.ts`, backlog #55): the judge now defaults to a
  `minor` severity floor (hides `trivial`/`info`), a `0.5` confidence floor (drops low-confidence
  non-critical findings; criticals always kept), and a 25-finding cap — all overridable. A global
  "be conservative, high-signal" directive is added to the shared specialist prompt (prefer fewer,
  higher-confidence findings; no nitpicks/restating/speculation). Whatever the floors hide is
  surfaced in the review notes (no silent suppression). Makes the default review useful, not noisy.
- Secret redaction before sending context to the provider (`src/review/redact.ts`): `redactSecrets`
  strips obvious secrets (private keys, AWS/GitHub/LLM/Google/Slack tokens, JWTs, `.env`-style
  assignments) — counting them, never logging the value — from the diff and from fetched context
  before either reaches a prompt; `isSensitiveFile` keeps credential files (`.env`, `*.pem`,
  `id_rsa`, `.npmrc`, …) out of the review entirely (reported as a `sensitive` skip) and refuses
  to read them during agentic retrieval. (backlog #15)
- End-to-end review pipeline + GitHub Action (`src/pipeline.ts`, `action.yml`): `reviewPullRequest`
  composes every stage — fetch → parse → size-guard → agentic context → multi-pass review +
  judge → walkthrough → publish — with heavy stages injectable for testing. A size-guarded diff
  renderer annotates changed lines with new-side numbers for clean inline mapping. The `review`
  CLI command is the Action entry point (token/PR/repo from flags or the GitHub event; `--dry-run`,
  `--min-severity`, `--no-context`). Ships a composite `action.yml` + a sample `prowl-review.yml`
  workflow (skips drafts, cancels superseded runs). (backlog #11)
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
