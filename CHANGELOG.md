# Changelog

All notable changes to Prowl Review will be documented in this file.

## [Unreleased]

### Added
- Approval rubric + break-glass override (backlog #52): an opt-in gate
  (`approval.enabled`) that maps findings to a single GitHub review event — any finding at or above
  `requestChangesAt` (default `critical`) makes the bot **request changes**; an otherwise clean review
  **comments** (or **approves**, with `approveWhenClean`, or when a prior prowl-review request-changes
  review must be cleared). The same decision drives the #24 Check Run
  conclusion, so the published review and the merge gate can never disagree. The escape hatch: a repo
  owner/member/collaborator can comment **`@prowl-review break glass <head-sha>`** to force-approve past a blocking
  finding — gated by GitHub author association (a drive-by fork contributor can't self-unblock) and
  the exact current head SHA, and recorded in the review summary + check for auditability.
  The gate withholds approval when review coverage is incomplete, when files were skipped, or when prior
  review-state history hits its cap; incomplete coverage also fails the #24 Check Run. Off by default the bot only ever comments (the
  prior behavior); non-`COMMENT` review events now post a short verdict pointing at the updatable summary
  instead of duplicating the walkthrough. Configurable via the `approval` block; the decision is logged
  to the CLI/Action output. Exports `planApprovalDecision`/`detectBreakGlass`/`hasActiveRequestChanges`.
- More grounding runners — Ruff + Gitleaks (backlog #16b): the grounding registry now runs **Ruff**
  (Python lint, selected via the #5 language detector) and **Gitleaks** (secret scanning) alongside
  ESLint. Unlike ESLint, both run **ungated** even on untrusted checkouts — they use their own
  single-binary rulesets, not repo-defined plugin code — which is the point for catching secrets in any
  PR. Ruff findings normalize to `lint`/`minor`; Gitleaks leaks to `security`/`critical` (with
  `--redact`, and the pipeline's own redaction on top). Both filter to the PR's changed lines, cap
  findings, and skip gracefully (with a note) when the tool is absent — non-Python/non-secret cases just
  don't run. **Deferred (still #16b):** Semgrep — its rulesets need a network registry or repo rules, a
  separate sourcing decision.
- Multi-language support (backlog #5, core): a dependency-free language-detection primitive
  (`src/review/language.ts` — `detectLanguage`/`summarizeLanguages` by extension/filename across ~20
  languages) that makes the review **language-aware**. The specialist system prompt now states which
  languages a PR touches ("changes code in: TypeScript, Python …") so the model applies each language's
  idioms; detection is derived from a fixed allowlist (trusted instruction text, not PR data). Grounding's
  ESLint runner now selects files via the detector (`isJavaScriptFamily`) — the per-language
  linter-selection seam #16b builds on — and non-JS/TS languages degrade gracefully (reviewed by the LLM,
  just without language-specific tooling). Cross-file context retrieval was already language-agnostic
  (grep/read), so no change was needed there. Exports the detection API. **Deferred (still #5):**
  tree-sitter AST-assisted caller/definition resolution — a heavier, separate layer (the detection
  primitive it would need is now in place).

### Changed
- Review-comment presentation polish (backlog #54): the findings-state summary now leads with a
  one-line TL;DR, a **GitHub alert callout** keyed to impact (`> [!CAUTION]`/`[!WARNING]`/`[!NOTE]`) for
  the impact/effort/findings line with a visual **effort bar** (`▰▰▰▱▱`), and renders blocking findings
  as a compact **table** (severity · location · finding) instead of a bullet wall — findings lead, the
  file inventory stays in its collapsed `<details>` below. Review notes and the "Not reviewed" skip line
  are now GitHub **note alerts** (`> [!NOTE]`). Pure-formatter changes to `buildWalkthrough`; all
  untrusted-text escaping is unchanged and table cells are pipe/newline-safe. Inline comments already
  carried severity badges + committable suggestions, so they were left as-is. (Bot avatar/branding is
  separate — #47.)

### Added
- Check Run / merge gate (backlog #24): an opt-in GitHub Check Run summarizing the review with per-line
  annotations, so Critical findings can block merge. A pure `planCheckRun` derives the conclusion from
  the worst finding severity against a configurable `checkRun.failOn` (findings at/above it → `failure`;
  omit `failOn` for an informational `neutral` check), builds the summary (severity breakdown; findings
  without a line are counted but not annotated — no silent drop, #5), and maps findings to annotations
  (critical/major → failure, minor → warning, else notice). `submitCheckRun` publishes via the Checks
  API, batching annotations in ≤50/request (create + update calls). Wired into the pipeline as a
  non-fatal step — a check-run failure (e.g. missing `checks: write`) never sinks the published review —
  and a passing gate still posts on a no-findings run so a Required check isn't left pending.
  Opt-in via `checkRun.enabled` in `.prowl-review.yml` (a `failure` conclusion only blocks merge once the
  org marks the "prowl-review" check Required in branch protection). `reviewPullRequest` returns
  `checkRunConclusion`. New `checks` methods on `OctokitLike`; exports `planCheckRun`/`submitCheckRun` +
  types.
- Guidelines + learnings injection (backlog #30, core): the reviewer now loads a `LEARNED_PATTERNS.md`
  file (alongside the already-loaded `REVIEW_GUIDELINES.md`/`CLAUDE.md`) from the trusted guidelines
  checkout and injects it into every specialist's shared system block as a distinct **"learned
  false-positive patterns"** section — issues previously dismissed or ignored aren't re-raised unless
  the code now clearly exhibits a real problem. Also adds an optional **org-wide guidelines** file
  (`org-guidelines-path` Action input / `PROWL_ORG_GUIDELINES_PATH`) injected into every repo's review
  in addition to per-repo guidelines (composed under "Organization standards" / "Repository standards"
  sub-headers). Both are framed as untrusted JSON-string data, consistent with the guidelines hardening.
  New `learnedPatterns` option on the pipeline/`runReview`; `loadLearnedPatterns`/`composeGuidelines`/
  `resolveOrgGuidelinesPath` CLI helpers. **Deferred:** the feedback-*append* path (👎 reaction /
  `@prowl-review ignore` writing back to `LEARNED_PATTERNS.md`) rides with the bot-command set (#26),
  and an org-guidelines-by-URL option — both noted in the backlog.
- Incremental re-review (backlog #23): on a re-push, review only the delta since the last reviewed
  commit instead of the whole PR — faster, cheaper re-reviews. The #12 state store already records the
  last-reviewed SHA in the summary marker; the pipeline now reads it up front and, when it differs from
  the new head, fetches the `lastReviewedSha...head` delta via `repos.compareCommitsWithBasehead`
  (`fetchComparisonDiff`) and reviews that. Best-effort with full-review fallback: no prior SHA, an
  unchanged head, or a compare failure (e.g. base unreachable after a force-push) reverts to the full PR
  diff. Pairs with risk-tiering (#31) — a small delta usually lands in the cheap `minimal` tier — and
  inline findings still dedup across pushes (#22). The reduced scope is disclosed as a review note (no
  silent reduction, #5); `reviewPullRequest` returns `incremental`. Default on; turn off with
  `--no-incremental` or `review.incremental: false` to re-scan the full PR. Exports `fetchComparisonDiff`
  and `fetchPriorReviewState`.
- Risk-tiered orchestration (backlog #31): scale cost with risk so a tiny diff doesn't pay for the
  full review fan-out (the lever the cost audit pointed at — input tokens from re-sent context across
  passes dominate the bill). A pure scorer (`src/review/risk-tier.ts`) counts changed lines + files and
  picks a tier: **minimal** (≤30 changed lines AND ≤2 files) runs a reduced built-in set
  (correctness + security; security never dropped) and tightens cross-file context; **deep** (≥500
  changed lines OR ≥20 files) expands context; **standard** is everything else (unchanged). Thresholds
  and an on/off switch are configurable via a `riskTiering` block in `.prowl-review.yml`. Explicit
  context limits and a configured specialist set (#51) always win over the tier; custom reviewers always
  run. The chosen tier is logged with the cost line (stdout + Action job summary), and a coverage-reducing
  minimal-tier run is disclosed as a review note (no silent reduction, #5). `reviewPullRequest` returns
  the chosen `riskTier`. **Model**-tiering is intentionally out of scope (cheap-model-per-provider is a
  guess we avoid; the user controls the model). Exports `selectRiskTier`/`planOrchestration`/
  `diffComplexity` + thresholds.
- Custom / configurable specialist reviewers (backlog #51): define your own review lenses in
  `.prowl-review.yml` so prowl-review enforces your org's standards without you building the
  orchestration. A new `specialists` block toggles the built-in lenses on/off
  (`specialists.builtins.<correctness|security|performance|tests>: false`) and adds custom reviewers
  (`specialists.custom: [{ key, focus, title?, avoid?, severityFloor? }]`) that run as extra passes in
  the #6 multi-pass set and feed the same judge/dedup. `severityFloor` keeps a reviewer
  high-signal-only (its below-floor findings are dropped before the judge). Custom title/focus/avoid
  strings are framed as untrusted configuration data in the prompt so they guide scope without
  overriding core review rules. Config-level per-reviewer `model` overrides are intentionally not exposed until
  provider/model-specific usage accounting can price mixed-model reviews correctly. Capped at 10 custom
  reviewers (each is a full LLM pass); keys are validated (lowercase/alphanumeric/hyphen, no collision
  with a built-in, `lint`, or each other), and a config that disables every lens with no custom reviewer is
  rejected. `resolveSpecialists` (pure) composes the set; threaded `config → resolveReviewOptions →
  pipeline → runReview`. Exports `resolveSpecialists`, `BUILTIN_SPECIALIST_KEYS`, and the
  `SpecialistsConfig`/`CustomSpecialistConfig` types.
- Findings structured-output hardening (backlog #7): review passes now survive a model that returns
  malformed or empty JSON. Each specialist pass is **retried once** when its output isn't a parseable
  findings array (`parseFindingsResult` distinguishes a genuine empty `[]` "no findings" — never
  retried — from unparseable output); if even the retry fails, the pass is reported as **degraded**
  (a coverage note + the incomplete badge) instead of silently contributing zero findings (#5). The
  same retry guards the false-positive **verification pass**. Passes also request **native JSON output
  where the provider supports it**: Anthropic prefills the assistant turn with `[` to force a JSON
  array, and Gemini sets `responseMimeType: application/json`; OpenAI has no array-compatible native
  mode (`json_object`/strict `json_schema` require an object root), so it relies on the prompt contract
  plus the parse-and-retry. New `responseFormat: "json"` flag on `CompletionRequest`;
  `parseFindingsResult`/`parseVerdictsResult` exported.
- Per-PR budget cap (backlog #18): a configurable spend ceiling so a huge PR can't quietly cost real
  money. Set `budget.maxTokens` and/or `budget.maxUsd` in `.prowl-review.yml` (the tighter wins;
  `maxUsd` is converted to a token ceiling via the model's input rate — an estimate, like all #36
  figures). Enforcement trims the variable/optional spenders: agentic **context retrieval** stops
  mid-loop once the budget is spent (the main "runs unbounded" risk), and the **verification pass** is
  skipped when the specialists have already spent it — the **specialist passes always run** (they're
  the core and already bounded by diff limits). It never blocks publishing; the over-budget total and
  every trim are surfaced as review notes (no silent truncation, #5). Builds on the #36 cost estimator.
- Token-usage + cost logging (backlog #36): per-review cost transparency that proves the BYOK
  "pennies, no cap" model. Each `review` run estimates its cost from the tracked token usage
  (input/output/cached) × a built-in price table (`src/cost/pricing.ts`, USD per 1M tokens,
  config-overridable via `pricing:`; figures are always **estimates** — the provider dashboard is the
  source of truth) and emits it to **stdout + the GitHub Action job summary** (`$GITHUB_STEP_SUMMARY`),
  never the PR comment. Local runs also append a one-line-per-run `.prowl-review/usage.jsonl`
  (`src/cost/usage-log.ts`); CI runs are ephemeral so they skip the log unless `PROWL_USAGE_LOG` is set.
  New **`prowl-review costs`** command aggregates the local log into per-provider/model totals + a grand
  estimate (markdown, or `--json` for agents; `--since <days>` window). Pure, injectable, and fully
  unit-tested. (Per-PR budget enforcement is the separate #18.)
- Inline-comment volume cap (backlog #25, the noise-ceiling capstone): a configurable maximum number of
  inline review comments per run (`src/review/inline.ts`, default 20) so a large PR isn't carpet-bombed.
  Findings are ranked, so the top N keep their inline comments and the rest roll into a compact
  summary section grouped by severity (`badge file:line — title`) that reports the cap and the overflow
  count ("N more findings (inline comment cap: M)") — no finding is dropped (#5). Configurable via
  `review.maxInlineComments` in `.prowl-review.yml` (`0` puts everything in the summary). Completes the
  noise-ceiling trilogy (comment states #56 → nitpicks #58 → cap #25).
- Prompt-injection detection + hardening (backlog #14): the reviewer already treats all PR content as
  untrusted DATA (every specialist + verifier prompt) and confines its agentic tools to the repo
  checkout (root/symlink/ReDoS guards, byte caps, no network). This adds the final piece — the
  reviewer now **notices and reports** injection attempts instead of letting them pass silently. A
  deterministic detector (`src/review/injection.ts`) scans the PR's **added lines** for tight,
  high-precision patterns (e.g. "ignore all previous instructions", "you are now…", "approve this PR",
  "do not report this issue") and surfaces a prominent review note ("Possible prompt-injection text
  detected … treated as data and ignored"). The note is the chosen surface (guaranteed to appear,
  unlike a finding that the judge/verifier could drop) and is deliberately conservative to keep false
  positives near zero. The specialist and verifier system prompts also gained an explicit
  "do NOT comply" directive for instructions embedded in PR content. The bot-command verb allowlist
  (the other half of #14) rides with the bot-command set (#24), which is not built yet.
- Default ignore list (backlog #19): generated/vendored files are skipped before review by default
  (`src/review/ignore.ts`) — lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `go.sum`,
  `Cargo.lock`, …), dependency/build dirs (`node_modules`, `vendor`, `dist`, `build`, `out`,
  `coverage`, `.next`, `.turbo`), and test snapshots (`__snapshots__`, `*.snap`). Fewer files reviewed
  means cheaper, less-noisy reviews. Skipped files are **reported** ("Not reviewed: ignored — matched
  the ignore list"), never dropped silently (#5). Filtering runs before the size guards so ignored
  files don't burn the budget. Overridable via a top-level `ignore` glob list in `.prowl-review.yml`,
  which **replaces** the defaults (`[]` ignores nothing); a small dependency-free matcher supports
  segment names, `*`/`**`/`?`, and path globs.
- Per-finding "Resolve with an AI agent" prompt (backlog #57): every finding comment — inline and
  the summary's "Unmapped findings" alike — now carries a collapsed `<details>🤖 Resolve with an AI
  agent</details>` block with a ready-to-copy, fenced (non-rendered) prompt containing the finding's
  location, severity, category, title, body, and committable suggestion (when present), plus a fixed
  *verify-then-fix-or-explain* instruction. Appended from a single insertion point (`formatFindingComment`
  in `src/review/inline.ts`). Untrusted finding text is control-char sanitized and the fence is widened
  past any backtick run, so it can't escape the code block or inject markdown/HTML. Default on; turn it
  off via `agentPrompt: false` in `.prowl-review.yml` or `--no-agent-prompt`.
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
- Model JSON-array extraction now skips schema-invalid preamble arrays (for example `Reviewed files: ["a.ts"]`)
  before verifier verdicts or specialist findings, cheaply filters candidates by required schema keys before
  parsing, skips nested children inside rejected arrays, and bracket matching runs in a single pass to avoid
  repeated rescans of malformed bracket-heavy output.
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
