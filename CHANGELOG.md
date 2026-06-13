# Changelog

All notable changes to Prowl Review will be documented in this file.

## [Unreleased]

### Added
- `.prowl-review.yml` config + `prowl-review init` (backlog #29, the config keystone): a Zod-validated,
  fully-optional per-repo config (`src/config/`) so a repo with no file still reviews with the documented
  defaults — the GitHub Action works out of the box. Tunes provider/model selection, the review floors
  (`minSeverity`/`minConfidence`/`maxFindings`), the verification pass (`verify`/`verifyConfidence`),
  cross-file context (`enabled`/`maxRounds`/`maxFiles`), linter grounding (`enabled`), and diff size
  guards. Precedence is **CLI flag > config file > built-in default**; for the provider, non-empty BYOK
  env vars (`PROWL_AI_PROVIDER`/`PROWL_AI_MODEL`) still win and the API key is never read from the
  file. The GitHub Action supplies `PROWL_AI_PROVIDER` from its trusted `ai-provider` input, which
  defaults to `anthropic`, so an untrusted repo config cannot redirect the provider endpoint. Config
  model overrides must be paired with a config provider, keeping provider-specific model names scoped. The
  Action also ignores repo config by default; workflows can opt into a trusted config via the
  `config-path` input. Workspace execution trust stays out-of-band via `--trust-workspace`,
  `PROWL_TRUST_WORKSPACE`, or the Action input, so an untrusted repo config cannot enable local code
  execution. The loader searches
  upward for `.prowl-review.yml`/`.yaml`, parses + validates with readable
  per-field errors (`.strict()` so a typo is a loud error, not a silent no-op), and never silently falls
  back to defaults on a malformed/invalid file. New `prowl-review init` scaffolds a commented config
  (refuses to clobber without `--force`); `review` gains `--config <path>` / `--no-config`. Expanded tests.
  This unblocks the deferred config toggles that ride on #29 (#56 `noFindingsComment`, #58 nitpick
  threshold, #57 `agentPrompt`, #25 inline cap, #19 ignore globs, #30 guidelines/learnings).
- LLM resilience: retry with backoff (`src/providers/retry.ts`, backlog #17 core): the review's
  default provider calls now retry transient failures — 429/408/425, 5xx, and network/timeout
  errors — with exponential backoff + full jitter, so a provider blip no longer degrades or sinks a
  review. Only transient errors retry (a 4xx or empty-content fails fast); `sleep`/`random` are
  injectable for deterministic tests. Applied transparently to specialist passes, the verification
  pass, and agentic context retrieval (an injected completion is used as-is). Cross-generation
  failback + heartbeat progress logs remain open under #17.

### Changed
- Swapped the clean "No issues found" headline emoji from the raccoon to a "ship it" rocket 🚀
  (`src/review/walkthrough.ts`): the clean state now reads `✅ No issues found 🚀` (and
  `✅ No issues found in reviewed files 🚀` when files were skipped).
- Verification now re-checks every inline-posted finding, not just low-confidence ones
  (`src/review/verify.ts`, #8/#58 noise follow-up): a finding is a verification candidate when it is
  **blocking (major+) OR below `verifyConfidence`**. Previously only sub-0.8 findings were verified, so a
  confident-but-wrong `major` finding skipped the skeptical pass and posted as a loud inline comment —
  the dominant noise on PR #27 (a hallucinated "path traversal", a "fails on spaces" on an
  already-quoted command, a self-contradicting "verify flag" finding). Blocking findings are exactly the
  ones that post inline, so they now get the skeptical look regardless of confidence; non-blocking,
  high-confidence findings stay trusted, so the pass is still risk-tiered (zero candidates → zero cost).
  The verifier prompt is also hardened to drop findings that reference code/identifiers not present in
  the diff/context (hallucinations), describe already-intended/documented behavior, or are
  self-contradictory / require no concrete change. `isBlockingFinding` is now exported.

### Fixed
- Verification follow-up cleanup (`src/review/run-review.ts`, `src/review/verify.ts`): aligned remaining
  public docs and review-note wording with the blocking-or-low-confidence verification rule, bounded verifier
  verdict parsing to reject oversized responses safely, and added explicit coverage for confident `critical`
  findings.
- Model JSON-array extraction now scans for the first complete array while respecting JSON strings and escapes,
  so trailing prose or bracket characters inside verifier verdicts or specialist findings do not corrupt parsing.
- Model JSON-array extraction now skips non-JSON bracketed preambles and returns the first bracketed payload that
  actually parses to an array.
- Benign context truncation no longer downgrades the whole review (`src/pipeline.ts`, backlog #56):
  a bounded agentic-retrieval hit — max rounds/files reached, or a truncated search/list result —
  was flipping the summary to "⚠️ Review incomplete — coverage degraded" even when all specialist
  passes and verification ran cleanly (e.g. PR #25, where a single truncated `gatherContext` grep
  triggered it). Like a guardrail file-skip, this is partial context on a healthy review, so it now
  renders as the clean state with the bound still surfaced as a note (#5 no silent truncation).
  "Review incomplete" is reserved for genuine inability to run — a failed specialist pass, failed
  verification, or context retrieval that threw.
- Gemini "returned no content" failures (`src/providers/gemini.ts`, toward backlog #17): the default
  `maxOutputTokens` was 4096, but Gemini 2.5 "thinking" tokens count against that budget — on a full
  review prompt thinking consumed it entirely, leaving no answer and failing the specialist passes
  (the recurring degraded reviews on recent PRs). Now sends a larger output budget (8192) plus a
  bounded `thinkingConfig.thinkingBudget` on 2.5+ models (omitted on older ones that reject it), and
  `BLOCK_NONE` safety settings so reviewing vulnerability/secret code isn't silently filtered. The
  empty-content error now reports the actual `finishReason`/`blockReason` instead of a generic
  message, so a degraded run is diagnosable. (Retry/backoff + cross-generation failback remain in #17.)

### Changed
- Nitpick bucket + severity/confidence calibration (backlog #58): cut the non-blocking polish that
  was popping up as prominent inline comments (PRs #22/#23 — hedged "could/might/potentially"
  findings, micro-optimizations, hypothetical-future refactors). The specialist + verifier prompts
  now grade anything speculative/precondition-dependent/micro-perf as `info` (prefer omit) **and**
  low confidence (≤0.4), so the severity floor hides it, the confidence floor drops it, and
  verification re-checks anything that slips through; the verifier explicitly drops
  doesn't-happen-now findings. Presentation: only blocking findings (`major`+) post as inline
  comments; `minor`-and-below render in a collapsed `🧹 Nitpicks (N)` section in the summary instead
  of peppering the diff. (Tune/verify the false-alarm drop with the eval harness #13.)
- Three distinct review-comment states (`src/review/walkthrough.ts`, backlog #56): the summary now
  renders differently by outcome instead of always a full report. **Clean** (healthy + nothing
  found) → a compact `✅ No issues found 🚀` with impact/effort/passes and the changed-files list
  tucked into collapsed `<details>` (no more `Findings: none` banner); when guardrails skipped
  files the review is still healthy but partial, so it stays clean with an honest caveat headline
  (`✅ No issues found in reviewed files`) + the "Not reviewed" note — not an alarming
  "Review incomplete" on every PR that touches a lockfile. **Degraded** (a specialist pass failed,
  verification failed, or context retrieval was truncated — i.e. the reviewer couldn't fully run) →
  a clear `⚠️ Review incomplete` message with the reasons, and **never** "Findings: none", so a
  review that couldn't run is no longer disguised as a clean pass. **Findings** → the full report as
  before. State selection is a pure, tested `reviewCommentState`.
- Collapse the changed-files overview behind a `<details>` disclosure in the review summary
  (`src/review/walkthrough.ts`): the summary now shows just a file count, with the grouped
  list one click away — so the file inventory is no longer a top-level wall of text on every
  review. (backlog #54)

### Added
- Linter/SAST grounding (`src/grounding/`, backlog #16 — the 4th differentiator): the pipeline runs
  the repository's own deterministic linters on the changed files and feeds the results into the
  review so the LLM **reconciles rather than re-discovers** (catching mechanical issues and curbing
  hallucination). ESLint is the first runner (`--format json` via `npx --no-install`, workspace-
  confined, bounded, changed-line filtered, graceful skip when absent); repo-local execution is
  gated behind `--trust-workspace` / the `trust-workspace` action input so untrusted PR checkouts do
  not execute their own ESLint config/plugins by default. Its messages normalize to findings
  (category `lint`, error→minor / warning→info, confidence 0.9). The findings merge into the
  review (deduped by the judge against anything the LLM re-found) and a compact "reconcile, don't
  re-report" summary is injected into every specialist prompt. Skippable via `--no-grounding`. The
  runner shape generalizes to Gitleaks/Semgrep and, with #5, more languages. 16 grounding unit tests.
- Review state persistence + update-not-duplicate (`src/review/state.ts`, `src/github/review.ts`,
  backlog #12 + #22 core): the summary is now a single top-level PR comment carrying a hidden,
  versioned state marker (last-reviewed SHA + posted-finding fingerprints). On a re-run prowl-review
  finds that comment by its marker and **edits it in place** instead of stacking a new review every
  push, and posts only **net-new** inline findings (deduped against fingerprints already posted on a
  prior push; fingerprints are SHA-256, line-independent, and include normalized title/body plus
  suggestion content so same-title findings with different details remain distinct).
  Net-new inline findings are submitted in one batched `pulls.createReview` call, and their
  fingerprints are persisted only after that review call succeeds; skipped or failed inline publishes
  remain retryable on the next run. Prior summary state is trusted only from the authenticated bot,
  and hidden inline fingerprint markers let the next run recover posted findings if the summary
  state write fails after review creation. The publish decision (`planPublish`) is pure and unit-tested.
  Deferred under #22/#23: GraphQL
  `resolveReviewThread` for outdated threads, human-reply handling, and incremental delta-review.
  One-time transition note: summaries posted before this change were review bodies, not issue
  comments, so the first run after upgrade creates a fresh summary comment (old ones are left as-is).
- Expanded the quality benchmark (`bench/`, backlog #13): added a real confirmed bug from a prior
  PR (secret-redaction regex truncating URL/connection-string values, #15) plus coverage the seed
  set lacked — a `tests` case (a test that asserts nothing), a second `correctness` case (a dropped
  `await`), and a second `clean` case (extract-constant refactor). All use neutral comments (no
  answer leakage, per the methodology fix Codex flagged on the harness PR).
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
