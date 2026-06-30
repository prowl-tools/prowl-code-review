# Changelog

All notable changes to Prowl Review will be documented in this file.

## [Unreleased]

### Added
- Auth policy + data-privacy docs (backlog #38 + #40, completes both): two authoritative pages stating how
  prowl-review authenticates and where code/keys go. `docs/auth.md` (#38) — BYOK keys read from the environment
  only (`PROWL_AI_PROVIDER` / `PROWL_AI_KEY_<PROVIDER>` preferred / `PROWL_AI_KEY` fallback; never from config or
  the repo), how the Action passes keys as masked secrets (blank inputs never exported), `GITHUB_TOKEN` posting,
  fork-PR key handling, and **why subscription/OAuth routing is not supported for Claude or Gemini** (Anthropic
  Consumer Terms §3.7; Google's Feb-2026 enforcement; OpenClaw precedent) with OpenAI/Codex the only possible,
  off-by-default, legally-gated future exception (#45). `docs/privacy.md` (#40) — code goes directly from the
  runner to *your* chosen provider (the three provider endpoints, no proxy / no prowl-review server), no
  telemetry/analytics (only provider + GitHub API calls), secret redaction + credential-file skipping before
  anything is sent (#15), and zero retention on our side (persisted state lives in your own GitHub). Extended the
  README "Security & privacy" section to link both, plus a docs-content guard test.
- Reusable org-level workflow (backlog #37, completes #37): roll prowl-review out across a whole org without
  copy-pasting the full workflow into every repo. New `examples/reusable/` ships two `workflow_call` (reusable)
  workflows for an org's `.github` repo — `prowl-review.yml` (auto-review) and `prowl-review-command.yml`
  (`@prowl-review` commands) — each owning the checkout, the trusted-base config/guidelines split, the
  fork + author-trust guards, and the pinned `prowl-tools/prowl-code-review@v1` invocation, with
  `ai-provider`/`ai-model`/`min-severity`/`config-path`/`org-guidelines-path`/`runs-on` inputs and BYOK key
  secrets. Per-repo opt-in is a few lines (`caller-prowl-review.yml` / `caller-prowl-review-command.yml`):
  declare the trigger + token scopes and `uses:` the org workflow with `secrets: inherit`. New
  `examples/reusable/README.md` (one-time org setup + per-repo opt-in + the permissions/pinning caveats),
  cross-links from `README.md` + `examples/README.md`, and a YAML-structure test guarding the templates against
  drift (valid YAML, the `workflow_call` contract, the published-action pin vs. the dogfood `uses: ./`, and the
  trust/fork guards).
- Repo-wide learnings + org-guidelines-by-URL (backlog #30, completes #30): two cross-PR capabilities, both
  BYOK with no external store. **Repo-wide learnings** — opt in with `review.repoLearnings: true` and an
  `@prowl-review ignore` / `resolve` mute is persisted (beyond its PR) to a dedicated **`prowl-review: learned
  patterns`** tracking issue, so the same finding is suppressed on every future PR (the OSS equivalent of
  CodeRabbit "learnings"). The store is a hidden versioned marker in the issue body (new `src/review/learnings.ts`:
  `parseLearnings`/`serializeLearnings`/`mergeLearnings`/`renderLearningsIssueBody`, de-duplicated by fingerprint
  and capped at 1000 with oldest-dropped fitting); reviews union its fingerprints into the suppression set, and
  the human controls it directly — delete a line to re-surface a finding, or close the issue to clear the store.
  New `fetchRepoLearnings`/`recordRepoLearnings`/`fetchReviewCommentLearningEntries` (issue read via
  `issues.listForRepo`, write via `issues.create`/`issues.update`; only open, bot-authored issues count). Writes
  are trust-gated (command authors only) and best-effort — a failed issue write never blocks the per-PR mute.
  **Org guidelines by URL** — `PROWL_ORG_GUIDELINES_PATH` now accepts an `http(s)` URL in addition to a file
  path (new async `loadOrgGuidelines`, 10s timeout + 256 KB cap), so an org can host one shared standard;
  fetched text stays untrusted prompt data, and a failed/non-OK/oversized fetch is skipped with a warning. New
  `review.repoLearnings` config key, pipeline `repoLearnings` option + `fetchRepoLearnings` dep, README docs,
  and public exports.
- Bot commands `resolve` + `configure` (backlog #26, completes the bot command set): two new trust-gated
  `@prowl-review` verbs. **`resolve`** — reply on a finding's thread to mark it resolved: it recovers the
  finding fingerprint from the bot's comment, resolves the matching open review thread via GraphQL, and mutes
  the fingerprint so it isn't re-raised (the difference from `ignore`, which leaves the thread open). Reuses the
  #22 thread plumbing (`fetchReviewThreads` + `resolveReviewThread`), so no new GraphQL was needed.
  **`configure <key=value …>`** — set per-PR review settings from a comment: an allowlist of `minSeverity`,
  `maxFindings`, and `verify` (with `configure reset` to clear), validated by a new `parseConfigureArgs` (a typo
  replies with usage rather than silently weakening the review). Overrides persist in the #12 summary state
  marker (new `configOverrides`) and win over the repo config on the next review (an explicit per-run option is
  only overridden when set); the applied overrides are surfaced as a review note. New `setConfigOverrides`
  (state-write helpers now all preserve `configOverrides`), `handleResolve`/`handleConfigure` orchestrators,
  dispatch + CLI wiring, README command-table + reply-handling docs, and public exports.

### Fixed
- Published-review ordering (presentation, #10/#22): on a PR's first review, the **walkthrough summary comment
  now appears above the flagged-findings review** in the conversation timeline, instead of below it. GitHub
  orders the timeline by creation time, and prowl-review previously created the review before the summary
  comment, so the findings landed on top. `submitReview` now **seeds the summary comment first** (with an empty
  #12 fingerprint marker), then posts the review, then updates the summary with the real posted-fingerprint
  marker — preserving retry-safety (a failed review submission never persists fingerprints for inline comments
  that don't exist; the inline markers remain the recovery source). Re-runs are unchanged (the existing summary
  is updated in place and stays above later reviews), so this is a first-run-only reorder. `OctokitLike`'s
  `issues.createComment` now returns the created comment id.

### Changed
- Default Anthropic model is now **`claude-haiku-4-5`** (was `claude-sonnet-4-6`). This moves the out-of-box
  default toward lower cost and latency while keeping prowl-review's multi-pass specialists, judge/dedup,
  false-positive verification, agentic cross-file context, and linter/SAST grounding in place. It is an
  intentional cost/speed trade-off, not a claim of measured parity with Sonnet; teams that prioritize maximum
  fidelity, large-PR handling, or eval-gated rollouts should pin a per-provider `model` (e.g.
  `claude-sonnet-4-6`) in `.prowl-review.yml` or compare models with `prowl-review eval` first. Haiku 4.5 has a
  smaller context window than Sonnet 4.6 and no older live same-family fallback target on the Anthropic API, so
  `resilience.failback` now treats it as terminal; after retry/backoff, sustained Haiku 4.5 overloads fail
  rather than downgrade. Large-PR or resilience-sensitive teams should pin Sonnet or configure diff/budget caps
  before switching. Only the built-in default changed — any explicit `model` / `PROWL_AI_MODEL` / `ai-model`
  setting is unaffected.

### Added
- Disputed-finding re-justification (backlog #22): when a developer replies "I disagree" (or "false positive",
  "not a bug", …) on a finding thread, the judge now **actively re-evaluates** the finding instead of silently
  withholding it. A new `src/review/rejustify.ts` pass takes the finding + the human's objection + the
  diff/context (all framed as untrusted DATA, secret-redacted) and decides to **defend** it — posting reasoned,
  sanitized in-thread reasoning that engages the objection, keeping the thread open and still gating merge — or
  **withdraw** it, conceding in-thread and resolving the thread (so it no longer blocks the approval gate). Wired
  into the #22 thread tidy-up via a GraphQL `replyToReviewThread` helper and the captured dispute reply; a
  failed/absent re-justifier falls back to the prior withhold-and-keep-open behavior, and dry runs never post.
  New `review.rejustifyDisputed` config toggle (default on), `ThreadTidyResult` gains `defended`/`withdrawn`
  counts surfaced in the review notes, and public exports for the rejustify + thread-reply surface.
- Docstring + unit-test generation commands (backlog #33): two new `@prowl-review` bot verbs that close out
  the item's CodeRabbit-style assists. `@prowl-review docstrings` drafts docstrings/doc-comments for the
  functions/classes/methods changed in the PR (each file's language convention); `@prowl-review tests` drafts
  unit-test stubs covering the changed behavior, inferring the project's test framework from the diff. Both are
  grounded in the size-guarded, secret-redacted PR diff (sensitive/ignored files filtered, same as chat #27),
  reply with copy-paste-ready fenced code blocks (in-thread when invoked on an inline comment, otherwise a PR
  comment), and treat all PR content as untrusted DATA. Output is markdown-sanitized + re-redacted before
  posting and labeled "review before committing." New `src/review/generate.ts`
  (`generateAssist`/`buildAssistSystem`/`buildAssistPrompt`/`assistLabel`), verbs wired through the parser +
  dispatcher with a `generateForComment` orchestrator, README bot-command entries, and public exports.
  Singular/`doc`/`docs` aliases accepted. True inline committable ```suggestion``` anchoring is a deferred
  enhancement (the assists post as copy-paste blocks for now).

### Changed
- Cohesive published review (presentation, #10/#22): the GitHub review that carries the inline findings now
  leads with a **self-contained findings summary** — `**prowl-review** flagged N findings` plus a severity
  breakdown (`🔴 1 critical · 🟠 2 major`) — so the review reads as one complete unit with its inline findings
  nested underneath (CodeRabbit-style). It replaces the previous one-line pointer ("posted N new inline
  findings. The updatable summary comment has the full review context."), which punted the reader to a
  separate comment and made the review look empty. This holds on every run, including re-runs (verdict reviews
  summarize the current findings, even when the matching inline threads were already posted). The persistent
  walkthrough summary comment is unchanged (still the updatable big-picture: impact/effort, changed files,
  per-model, nitpicks, notes, state marker — #22/#12). Verdict reviews (APPROVE/REQUEST_CHANGES, #52) likewise
  lead with the verdict + the same findings summary instead of a pointer; REQUEST_CHANGES reviews also embed
  sanitized summary details when findings are deduped, capped, or summary-only so the change request remains
  actionable. `ReviewComment` now carries `severity`; new exported `buildPublishedReviewBody`.

### Added
- Semgrep SAST grounding (backlog #16b): a new deterministic grounding runner alongside ESLint/Ruff/Gitleaks.
  prowl-review runs **Semgrep** over changed source files (multi-language, selected via the #5 detector) and
  feeds its findings into the review so specialists reconcile with real SAST results instead of re-discovering
  them. Runs by default and **skips gracefully when Semgrep isn't installed**. The ruleset-sourcing decision:
  the default is Semgrep's curated `p/default` registry pack, fetched with **metrics off** (no project metadata
  uploaded — so `--config auto`, which phones home, is deliberately not the default) and `--disable-version-check`.
  Only Semgrep registry refs (`p/…`, `r/…`, `auto`) are supported; repo-supplied rulesets and remote
  `http(s)://` configs are skipped even on trusted workspaces. Untrusted scans bypass repo `.gitignore` /
  `.semgrepignore` target filters, skip symlink targets, and disable inline `nosemgrep` suppressions so changed
  regular files cannot hide from SAST grounding. Findings are mapped to severity/category, filtered to changed lines, and bounded by the existing
  grounding caps. New `grounding.semgrep` config block (strict Zod, `enabled` + `config`),
  `parseSemgrepJson`/`DEFAULT_SEMGREP_CONFIG` exports, and pipeline/CLI wiring.
- Suggested-fix validation (backlog #39): committable one-click ```suggestion``` blocks are now gated so a wrong
  fix can't break the build. A suggestion is only rendered as committable when its finding clears a **confidence
  floor** (`suggestions.minConfidence`, default 0.8) **and** passes a deterministic, no-execution **structural
  check** (rejects empty suggestions, truncation placeholders like `// ...` / `// rest of the code`, and leaked
  redaction markers; never rejects on bracket balance, since a valid suggestion may replace lines inside a
  block). Lower-confidence fixes stay available in the finding's agent prompt (#57) rather than as a one-click
  commit, and withheld suggestions are reported in the review notes (#5: no silent drop). Gating happens at the
  render layer so #12 fingerprints stay stable. New `src/review/suggestions.ts`
  (`validateSuggestion`/`shouldCommitSuggestion`/`summarizeSuggestionGating`), a `suggestions` config block
  (strict Zod), and pipeline/CLI wiring. The heavier "apply-and-typecheck the fix in a sandbox" option is
  intentionally deferred — it would execute untrusted fix code.
- Dependency-CVE / license scanning (backlog #34): a new deterministic grounding runner. When a PR changes a
  dependency lockfile, prowl-review scans it with **osv-scanner** (Google OSV — multi-ecosystem, lockfile-based,
  reads manifests as data so it never executes repo code) and surfaces **known vulnerabilities** as file-level
  findings (one per advisory: CVE id, affected `pkg@version`, fixed version, severity mapped from the GHSA
  label or CVSS score). Runs by default and **skips gracefully when osv-scanner isn't installed**. Lockfiles
  are scanned from the full diff even though the ignore list (#19) excludes them from line-review, and an
  optional SPDX **license allowlist** (`dependencyScan.licenses.allow`) additionally flags dependencies whose
  license is outside the policy. New `runDependencyScan`/`parseOsvJson`/`dependencyScanTargets` in
  `src/grounding`, a `dependencyScan` config block (strict Zod), and pipeline/CLI wiring. The judge now keys
  file-level dependency findings by title so distinct advisories in one lockfile don't collapse together.
- npm + Homebrew distribution (backlog #42): a tag-triggered release pipeline. New
  `.github/workflows/publish.yml` fires on a `vX.Y.Z` tag, verifies the tag matches `package.json`, runs
  `npm ci` → build → lint → test, verifies release notes, prepares a draft GitHub Release, publishes to npm
  with provenance (`npm publish --provenance --access public`, OIDC via `id-token: write`, `NPM_TOKEN`
  secret), then publishes the GitHub Release. The release notes come from a new, unit-tested
  `scripts/changelog-section.mjs` (extracts `## [X.Y.Z]`, falls back to `## [Unreleased]`). Made the package
  publish-ready (`publishConfig.access: public`). Added a Homebrew formula template
  (`packaging/homebrew/prowl-review.rb`, for the separate `homebrew-tap` repo), a `docs/releasing.md`
  maintainer guide, and a README **Install (CLI)** section (`npm i -g prowl-review` / `npx` / `brew`).
- Repo hygiene & demo (backlog #41): OSS-credibility scaffolding for the public repo. Added
  `CONTRIBUTING.md` (setup, project layout, conventions, the Definition of Done, how to extend a
  provider/specialist/grounding runner), `SECURITY.md` (private vuln reporting + the BYOK/secret/trust model +
  fork-PR handling), `CODE_OF_CONDUCT.md` (Contributor Covenant), GitHub issue templates (bug/feature +
  a config that routes security reports to private advisories) and a PR template, and an `examples/` quickstart
  (ready-to-copy auto-review + command workflows and a starter `.prowl-review.yml`). Documented the
  **no-telemetry / no-analytics** policy (only network calls are to your provider + the GitHub API; any future
  telemetry would be opt-in, default off) in SECURITY.md and the README. Added `docs/example-review.md` — a
  rendered sample walkthrough (summary, findings table, 🤝 consensus, per-model sections) as the canonical
  "what it looks like" reference; a screen-capture/GIF and a standalone demo repo remain a follow-up.
- Fork-PR handling / security model (backlog #20): defined, safe behavior when a pull request comes from a
  fork. On a fork PR with **no provider key** — the normal case, since GitHub doesn't share secrets with fork
  `pull_request` runs — prowl-review now **skips with a clear message** (and a tolerant neutral check run)
  instead of crashing on the missing key; the skip happens before any prior-state fetch. When a fork *is*
  reviewed (e.g. via `pull_request_target`, where a key + write token are present) it logs that the fork is
  untrusted and proceeds without trusting fork code. Hardened config loading: `.prowl-review.yml` is **no
  longer auto-discovered** from a fork checkout (only an explicit, maintainer-set `config-path` is honored on
  forks), closing a review-policy-tampering vector — complementing the existing `--trust-workspace`
  force-off on forks. New `resolveForkReviewDecision` + `hasAnyProviderKey` helpers; README "Fork pull
  requests" section with the `pull_request_target` pattern.
- Debug/verbose mode (backlog #49): opt-in structured run tracing for diagnosing odd reviews. The `--debug
  [path]` flag (or `PROWL_DEBUG`/`PROWL_DEBUG_LOG` env, `debug.enabled`/`debug.path` config, or the Action
  `debug` input) writes a **line-per-event JSONL trace** of what a run actually did: the assembled prompts
  (specialist + verification passes), the fetched-context file list, the findings at each stage (per-pass →
  raw → verified → judged), and the token/cost breakdown. File writes are queued as ordered async appends so
  tracing does not block review work on per-event disk I/O; every string field is redacted (#15) at
  serialization. New `src/debug/trace.ts` (`DebugEvent`/`DebugSink`, `createJsonlSink`, `createDebugRecorder`),
  threaded through the pipeline, local review mode, the multi-pass review, and the ensemble (including the
  final cross-provider judge event). The default trace lives at `.prowl-review/debug.jsonl`; local diff guards
  ignore prowl-generated `.prowl-review/` outputs so the default does not break later local reviews in repos
  that have not ignored that directory. Trace paths are confined to the workspace, reject symlinked components,
  and create nested parent directories automatically.
- LLM resilience: cross-generation failback + heartbeat (backlog #17). **Failback** (opt-in via
  `resilience.failback.enabled`): when a review pass keeps hitting retryable/overload errors (429/503/5xx)
  after retries are exhausted, it retries with an **older model of the same family + provider**
  (`claude-opus-4-8` → `4-7` → …; `gemini-2.5-pro` → `gemini-2.5-flash`) before failing — a degraded-but-real
  review beats a failed pass. Never crosses providers (that's the ensemble, #53), never falls back on a
  non-retryable error, and each failback is surfaced as a review note. New `src/providers/failback.ts`
  (`modelFailbackChain` + `withFailback`), applied to specialist + verification passes (single and ensemble).
  **Heartbeat**: `withHeartbeat` ticks a progress log (default every 30s) while a long review is in flight, so
  a slow ensemble run isn't mistaken for a hung CI job; the CLI also logs transient retries via the `onRetry`
  hook. New `src/review/heartbeat.ts`.

### Fixed
- Duplicate review comments on the GitHub Action (#22): the Actions `GITHUB_TOKEN` is an installation
  token, so `GET /user` 403s and the bot couldn't resolve its own login — the prior summary comment was
  never found, so a **new walkthrough was posted every run** (and incremental re-review #23, pause/resume
  #26, the ignore list #30, and thread tidy #22 all silently no-op'd). `getAuthenticatedLogin` now resolves
  via explicit override → `GET /user` → `PROWL_BOT_LOGIN` hint → `github-actions[bot]` (the default-token
  identity) inside Actions. New `bot-login` Action input (empty by default; set it for custom
  GitHub-App tokens that cannot resolve their login through `GET /user`). Existing duplicate comments on open
  PRs need a one-time manual delete.

### Changed
- Cohesive review publishing (#22): inline findings for the default `COMMENT` review are published in one
  `pulls.createReview` call with `comments[]`, so GitHub receives a single review submission instead of one
  API call per finding. The updatable walkthrough comment is still edited in place, and an explicit
  Request-changes/Approve verdict (#52) carries its inline findings on that one verdict review.
- Per-model findings in the ensemble walkthrough (#53): below the consolidated table, a **Per-model
  findings** area shows one collapsible section per provider listing that model's own findings (its wording +
  severity), so it's clear which model said what — not just the deduped result.
- Per-model section glyphs (#53) now use brand-colored **squares** — 🟧 Anthropic, 🟦 OpenAI, 🟩 Gemini —
  visually distinct from the severity **circles** (🔴/🟠/🟡/🔵/⚪), instead of the previous mixed
  circle/diamond set.

### Added
- Issue/ticket validation (backlog #32): when a PR links a GitHub issue, prowl-review pulls the issue's
  acceptance criteria and flags any the diff doesn't satisfy. Opt-in via `issueValidation.enabled` (default
  off; `maxIssues` default 3). Linked issues are parsed from the PR title/body — closing keywords
  (`Closes #12`, `Fixes owner/repo#5`) and issue URLs (a bare `#n` needs a keyword) — fetched tolerantly
  (missing/inaccessible/PR/empty → skipped with a note), and their criteria are fed to a new conditional
  `requirements` review lens that runs alongside the configured specialists (in single- and ensemble-provider
  runs) and raises a finding per unmet criterion. The issue text is treated as untrusted data and secret-
  redacted. New `src/review/issue-refs.ts`, `src/github/issues.ts` (`issues.get` added to the Octokit
  surface), and a reserved `requirements` specialist key; the result reports `issuesValidated`.
- Auto-generated PR descriptions (backlog #33): when a pull request is opened with an empty body,
  prowl-review writes a description from the diff and PATCHes it into the PR body — CodeRabbit-style. Opt-in
  via `prDescription.enabled` (default off). The summary lives between `<!-- prowl-review:pr-summary:start/end -->`
  markers so re-runs refresh it in place while preserving any author text around it; a human-authored
  description is **never** overwritten (it only fires on an empty body or prowl-review's own prior block).
  Title/diff are framed as untrusted data and the output is secret-redacted + sanitized. New
  `src/review/pr-description.ts`, `pulls.update` on the Octokit surface + `updatePullRequestBody`; the result
  reports `prDescriptionUpdated`. Needs `pull-requests: write` (already required to post reviews).

### Removed
- Retired the placeholder `anthropics/claude-code-action` workflows (backlog #44): deleted
  `.github/workflows/claude-code-review.yml` (the baseline auto-reviewer, now redundant with the
  prowl-review ensemble that reviews every PR) and `claude.yml` (the `@claude` assistant, superseded by
  `@prowl-review` chat/commands, #27). The repo is now prowl-review-only (`prowl-review.yml` +
  `prowl-review-command.yml` + `ci.yml`); CLAUDE.md's "Existing Workflows" section updated to match.

### Added
- Per-provider key inputs on the GitHub Action (backlog #53 follow-up): `action.yml` gains
  `ai-key-anthropic` / `ai-key-openai` / `ai-key-gemini` inputs, each forwarded to the matching
  `PROWL_AI_KEY_<PROVIDER>` env var, so the multi-provider ensemble can be driven from the Action (the
  composite step previously forwarded only the generic `ai-key` → `PROWL_AI_KEY`). Empty inputs are treated
  as unset, so existing single-provider workflows are unaffected. README documents the explicit per-provider
  key setup (each provider its own key, primary listed first for the shared context pass). The repo now
  **dogfoods the ensemble**: a root `.prowl-review.yml` runs a Claude + Gemini ensemble (cheap priced models:
  `claude-haiku-4-5` + `gemini-2.5-flash`), and both dogfood workflows pass the per-provider keys + a trusted
  base-branch `config-path`; their availability guards require an ensemble-capable base action so they
  self-bootstrap on merge.
- Per-model perspectives on ensemble findings (backlog #53 follow-up): when the ensemble consolidates an
  issue more than one model flagged, the inline PR comment now preserves **each model's own take** in a
  collapsible "🔀 N model perspectives" block (per-provider severity, confidence, and reasoning), instead of
  showing only the chosen representative — two perspectives in the same PR without multiple tools.
  Single-provider findings get a "🔎 Raised by X (1 of M providers)" attribution line. New
  `Finding.perspectives` (`ProviderPerspectiveSchema`), orchestrator-set and omitted from model-output
  parsing; the ensemble seeds one perspective per finding and the cross-provider judge merges them (one
  entry per provider, strongest take) while consolidating.
- Multi-provider ensemble review (backlog #53): opt-in (`ensemble.enabled`, default off) review of the same
  changes across multiple providers at once, with findings consolidated cross-provider — a BYOK-only edge.
  Each provider's key is read from its own env var (`PROWL_AI_KEY_ANTHROPIC` / `_OPENAI` / `_GEMINI`; the
  primary also falls back to `PROWL_AI_KEY`), listed under `ensemble.providers` in `.prowl-review.yml`. The
  cross-file context (#4) and linter/SAST grounding (#16) run once and are shared; each provider then runs
  the full multi-pass review (#6/#8) in parallel (`runEnsembleReview`), error-isolated so one provider
  failing degrades gracefully (reported, never silent). A cross-provider judge (`judgeEnsembleFindings`)
  dedupes with **provenance** (`Finding.sources`) and **boosts confidence on agreement** — applied before
  the confidence floor, so consensus can rescue a finding each provider scored just under threshold
  (complements the false-positive pass, #8). Consolidated findings carry a **🤝 N/M consensus badge** in the
  walkthrough table/nitpicks and a "flagged by N of M providers (…)" note on inline comments; single-provider
  findings are kept and marked. Cost is ~N× a single review — the per-PR budget (#18) is split evenly across
  providers, risk-tiering (#31) still applies, and the multiplier is documented. New modules
  `src/providers/ensemble.ts` (`resolveEnsembleConfigs`) and `src/review/ensemble.ts`; exported from the
  library surface.
- Draft-PR & auto-review controls (backlog #28): prowl-review now **skips draft pull requests by default**,
  reviewing automatically once the PR is marked ready for review (the `ready_for_review` event) — or
  immediately if you comment `@prowl-review review` (an explicit request always runs, even on a draft). Two
  new `.prowl-review.yml` keys under `review`: `auto` (default `true`; set `false` for **on-demand only** —
  the bot reviews just when asked) and `reviewDrafts` (default `false`; set `true` to auto-review drafts).
  The auto path reads draft status from the GitHub event payload (`resolveIsDraftEvent`) and, for each skip
  reason (paused / `auto: false` / draft), posts a neutral merge-gate check run when the check is enabled so
  a Required "prowl-review" check isn't left pending. The paused check-run helper was generalized into
  `maybeSubmitSkipCheckRun`.
- Local pre-push review mode (backlog #35): `prowl-review review --base <ref> [--head <ref>]` runs the
  full review engine against a **local git diff** and prints findings to the terminal — no GitHub token,
  no posting. The diff is taken relative to the merge base of `--base`/`--head` (PR semantics, via
  `git diff --merge-base`); omitting `--head` reviews the working tree, while an explicit `--head`
  must match the checked-out `HEAD` with a clean worktree because local context and grounding read from the checkout.
  Passing `--base` or `--head` switches the `review` command into local mode. It reuses the same agentic cross-file context (#4),
  linter/SAST grounding (#16) over the local checkout, multi-pass review + verification + judge, risk
  tiering (#31), per-PR budget (#18), secret redaction (#15), and the "no silent truncation" skip
  reporting (#5). New flags: `--json` (machine-readable output), `--no-color` (also honors `NO_COLOR`),
  and `--fail-on <severity>` (non-zero exit for a pre-push gate). Repo-local linter execution remains
  opt-in via `--trust-workspace` or `PROWL_TRUST_WORKSPACE=true`. New modules `src/review/local-diff.ts` (injectable git exec),
  `src/review/format-terminal.ts` (pure findings/notes/JSON renderer), and
  `src/cli/commands/review-local.ts` (`runLocalReview`); all exported from the library surface.
- `@prowl-review ignore` → per-PR learned mute (backlog #30 remainder, finishing the
  deferred #26 `ignore` verb): reply `@prowl-review ignore` on a finding's comment and prowl-review stops
  raising it on that PR. The handler recovers the finding's fingerprint from the bot's root comment marker
  and merges it into an `ignoredFindings` list persisted in the summary comment's state marker (#12); future
  reviews suppress those findings **before** the approval gate, so a muted finding never drives
  request-changes or re-posts. Trust-gated to owner/member/collaborator like the other commands; muting is
  acknowledged in-thread, and a top-level `ignore` (no finding thread) replies with guidance. Prior state
  is now loaded on every run (it carries the ignore list as well as the incremental SHA). Exports
  `setIgnoredFindings`/`fetchReviewCommentFingerprints`. **Deferred (still #30):** repo-wide learnings
  (writing back to `LEARNED_PATTERNS.md` across PRs) — needs a persistent store/commit; today the mute is
  per-PR (which is what "persisted per #12" describes). A 👎-reaction trigger is impractical via Actions.
- `@prowl-review` chat replies (backlog #27): mention the bot with a free-form
  question and get a contextual, in-thread answer grounded in the PR. Any `@prowl-review` comment that
  isn't a known command verb is treated as a question (`@prowl-review why is this O(n²)?`): the new
  `command` handler fetches the PR, builds a size-guarded + secret-redacted diff context, and asks the
  configured provider for a concise, Markdown answer (`src/review/chat.ts` — `generateChatReply`). The PR
  title/body/diff and the question are framed as **untrusted data** in the prompt so an injection in the PR
  can't redirect the bot, and the reply is redacted again before posting. Replies thread correctly: inline
  for a `pull_request_review_comment` (via `createReplyForReviewComment`, carrying the file/line/hunk
  context), or a top-level PR comment otherwise. Honored only from a trusted author
  (owner/member/collaborator); the provider key is resolved lazily so non-chat verbs never require it. The
  command workflow now also triggers on `pull_request_review_comment`. Exports
  `generateChatReply`/`buildChatPrompt`/`sanitizeChatReplyMarkdown`.
- Bot command set (backlog #26): drive the reviewer from the PR by commenting
  `@prowl-review <verb>`. A pure, conservative parser + verb allowlist (#14) recognizes **`review`**
  (re-review the latest changes), **`full review`** (force a full re-scan), **`pause`** / **`resume`**
  (toggle auto-review on new pushes, persisted in the summary comment's state marker), and **`help`**;
  anything else replies with the command list. Commands are honored only from a trusted author
  (owner/member/collaborator, mirroring break-glass #52); `review`/`full review` override pause since
  they're explicit. A new `command` CLI subcommand reads the `issue_comment` / `pull_request_review_comment`
  event, trust-gates, and dispatches; the composite Action gains a `mode: command` input and a documented
  `prowl-review-command.yml` workflow listens for `@prowl-review` PR comments. Exports
  `parseCommand`/`commandHelpText`/`setPausedState`. **Deferred (still #26):** `ignore` / `resolve` /
  `configure` — these target a specific finding/thread from the reply context, which rides with the #30
  learnings write-back and #22 reply infra.
- Workflow concurrency control (backlog #21): the GitHub Action workflow uses a
  PR-keyed `concurrency` group with `cancel-in-progress`, so rapid re-pushes cancel the superseded
  review instead of spawning overlapping runs that race to comment. To close the brief overlap window
  `cancel-in-progress` leaves (a just-cancelled run can still be mid-publish), prowl-review now **re-checks
  the PR head right before publishing** and skips the publish (and the #24 check run) when the head has
  advanced past the SHA it reviewed — a newer run supersedes it — so stale results never clobber the
  summary for an outdated commit. The guard is tolerant (a failed head re-check publishes normally), never
  runs on `--dry-run`, and can be disabled via `cancelIfHeadAdvanced: false`. README gains a documented
  sample workflow carrying the concurrency pattern + permissions. Exports `fetchPullRequestHeadSha`.
- Resolve fixed threads + respect human replies (backlog #22 remainder): on a
  re-run prowl-review now tidies its prior finding threads. It **resolves** a thread (via the GraphQL
  `resolveReviewThread` mutation — the REST API can't) when the finding is gone from the latest review
  (fixed), and it **honors human replies**: replying "won't fix" /
  "acknowledged" resolves the thread and withholds the finding so it isn't re-raised, while "I disagree"
  keeps the thread open and withholds the finding (withdrawn from re-emit) pending re-review instead of
  blindly re-posting it. Reply intent is classified from the newest decisive recent User-authored comment by a pure,
  conservative matcher (ambiguous, negated completion like "not fixed", or negated dispute wording
  like "not a false positive" / "I don't think this is a false positive" -> no action; later non-decisive
  follow-ups like "thanks" do not erase an earlier settle/dispute; bot/app comments and untrusted PR
  authors cannot settle a thread). Withheld findings, kept-open disputed threads, and
  settled thread actions from incomplete re-runs are handled **before** the approval gate (#52), so a
  finding a human settled or disputed no longer drives request-changes, but it also prevents automatic
  approval until an explicit human approval or break-glass override, and required #24 Check Runs fail
  while those thread blockers remain; break-glass overrides can explicitly unblock
  withheld thread blockers. Fixed auto-resolution is skipped on incremental
  delta-only, capped, or otherwise incomplete reviews, where the current findings are not a full-PR set; after
  settled/disputed findings are withheld, capped reviews refill from the uncapped ranked set so lower-ranked
  unsuppressed findings are not hidden by already-settled ones. Fingerprints from
  fixed/resolved threads are allowed to post a fresh inline comment if the issue reappears, but stop being
  considered repostable once an open replacement thread already carries the same fingerprint. Sensitive-file
  grounding findings are preserved even when no provider-reviewable files remain and prior threads are fetched. Thread resolution
  mutations run with bounded concurrency. All thread I/O is GraphQL and tolerant (a failure never
  sinks the review); opt out via `review.resolveThreads` / `--no-resolve-threads`. Exports
  `planThreadActions`/`fetchReviewThreads`/`resolveReviewThread`/`classifyReplyIntent`. **Deferred (still
  #22):** on "I disagree", have the judge actively re-justify or formally withdraw the finding (rides with
  the bot-command/event infra, #26/#27) — today the finding is withheld, not re-argued.
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
