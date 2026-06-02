# Backlog

Prioritized list of planned features, improvements, and technical debt for **`prowl-review`** — a BYOK (bring-your-own-key) AI code-review tool for the Prowl QA suite. Delivered first as a GitHub Action + local CLI in TypeScript, reusing `prowl`'s toolchain and the provider abstraction from `prowl/src/generator/ai.ts`. Multi-provider (Claude default / OpenAI / Gemini). Apache-2.0.

**Positioning (why we're building, not just tuning Claude Code's review):** a single-pass, diff-only LLM review (what Claude Code and Codex do today) misses the bugs that live in the seam between changed code and its callers, and it *reads* like a wall of text. The paid tools (CodeRabbit, Greptile, Qodo) win on four techniques + presentation, all replicable BYOK: (1) **cross-file context** via **agentic retrieval** (grep/read on demand — NOT a vector DB), (2) **multi-pass specialized review + a judge/dedup pass**, (3) **linter/SAST grounding**, (4) **false-positive verification**; plus a **structured walkthrough + committable inline suggestions**. Cost is managed via **prompt caching** + **risk-tiered** agent counts, so per-review stays in cents — still far under CodeRabbit's ~$576/yr for this user.

User stories use **As a `<role>`, I want `<capability>`, so that `<value>`.** Each carries acceptance criteria.

## High Priority

1. **TypeScript package scaffold matching `prowl`**
   As a maintainer, I want a new TS package (`prowl-review`) wired with prowl's exact toolchain, so that the reviewer is consistent with the suite and easy to ship.
   - Acceptance: `package.json` (name `prowl-review`, `bin`, scripts), `tsup.config.ts`, `tsconfig.json` (strict, ESM), `.eslintrc.cjs`, Vitest — copied/adapted from `prowl`.
   - Acceptance: `npm run build` produces a runnable `dist/cli.js`; `npx prowl-review --help` prints commands. Apache-2.0 LICENSE + NOTICE present.

2. **Multi-provider BYOK LLM abstraction + prompt caching**
   As a developer, I want to pick Claude, OpenAI, or Gemini via env vars with caching built in, so that I'm never vendor-locked and reviews stay cheap.
   - Acceptance: `providers/` exposes one interface; selection via `PROWL_AI_PROVIDER` (default `anthropic`) + `PROWL_AI_KEY`, mirroring `prowl/src/generator/ai.ts`. Anthropic/OpenAI/Gemini implementations; sane default models (e.g. a stronger model for the judge, cheaper for specialist passes).
   - Acceptance: **prompt caching** wired so stable content (system prompt, guidelines, fetched repo context, tool defs) is cached and only the diff is uncached; cache-aware token accounting. Target high cache-hit on re-reviews.
   - Acceptance: unit tests for provider selection, missing-key error, and cache-block construction (`fetch` mocked).

3. **Diff fetch + parsing with size guards**
   As a developer, I want the tool to fetch a PR's diff and parse it into files/hunks/lines, so that reviews target real changed code and inline comments map to exact lines.
   - Acceptance: `github/diff.ts` fetches PR diff + metadata via Octokit (`@actions/github`).
   - Acceptance: `review/parse-diff.ts` maps hunks to `path` + new-side line numbers (and ranges) for later inline comments.
   - Acceptance: config caps (`maxFiles`, `maxDiffBytes`) chunk/skip oversized diffs; skipped content is reported, never silently dropped.

4. **Agentic cross-file context retrieval (the #1 bug-catching lever)**
   As a reviewer, I want the agent to pull in the callers, callees, and related files of changed code on demand, so that it catches broken callers, contract/interface violations, and inconsistent patterns that diff-only review misses.
   - Acceptance: the review agent has **read-file + grep/search tools** over the checked-out repo and decides what to fetch (agentic retrieval) — **no vector DB / embeddings**.
   - Acceptance: for each changed export/function, the agent can locate and read its callers and definition sites; fetched context is added to the (cached) prompt.
   - Acceptance: bounded by config (max files/bytes fetched) and reported; works in the GitHub Action checkout and locally.

5. **Multi-pass specialized review + judge/dedup pass**
   As a reviewer, I want several focused passes (correctness, security, performance, tests) merged by a judge, so that diverse lenses catch more and a single clean result is produced.
   - Acceptance: N specialist passes run in parallel, each with a tightly-scoped prompt; configurable set.
   - Acceptance: a **judge pass** dedups (hash of file+line+category), re-categorizes, drops nitpicks/speculation, and ranks by severity — producing one consolidated finding list.
   - Acceptance: shared context written once and referenced by passes (avoid N× token blow-up); unit tests for dedup/merge.

6. **Findings schema (severity + confidence) + review prompts**
   As a developer, I want structured, severity- and confidence-tagged findings, so that output is consistent, filterable, and machine-mappable to comments.
   - Acceptance: Zod schema — `file`, `line`/range, `severity` (Critical/Major/Minor/Trivial/Info), `confidence` (0–1), `category`, `title`, `body`, optional `suggestion`.
   - Acceptance: specialist + judge prompts in `review/prompt.ts`, built from diff + fetched context; providers return validated findings (retry on malformed).

7. **False-positive verification pass**
   As a developer, I want low-confidence findings re-checked skeptically before posting, so that the review is high-signal and not naggy.
   - Acceptance: findings below a confidence threshold get a second "is this actually a bug?" pass that can demote/drop them.
   - Acceptance: severity threshold + dedup applied before posting; counts of dropped/false-positive findings logged.

8. **Structured walkthrough summary (presentation)**
   As a reviewer, I want a clean PR walkthrough comment, so that the review reads premium instead of a text wall.
   - Acceptance: one summary body with: plain-language summary, **Impact + estimated-effort** badges, a grouped/layered changed-files overview, and severity counts (🔴/🟠/🟡 …).
   - Acceptance: optional **Mermaid** sequence/flow diagram when the PR affects a clear flow (feature-flagged; degrade gracefully).

9. **Inline comments with committable suggestions (presentation)**
   As a reviewer, I want findings posted inline on exact lines with one-click fixes, so that it feels like CodeRabbit/Greptile and I can apply fixes instantly.
   - Acceptance: a **single cohesive review** (`POST .../pulls/{n}/reviews`) with summary body + `comments[]` mapped to `path`/`line`/`side` (multi-line ranges supported).
   - Acceptance: each finding renders a **severity badge** + a committable ```suggestion``` block when a safe fix exists; findings outside the diff fall back to the summary.

10. **GitHub Action wrapper + dogfood**
    As a developer, I want a drop-in Action, so that adding one workflow file + an API-key secret enables premium reviews on any repo with no hosting.
    - Acceptance: `action.yml` (Node action) triggers on `pull_request` [opened, synchronize, ready_for_review, reopened]; runs the full pipeline.
    - Acceptance: declares `permissions: pull-requests: write, checks: write, contents: read`; uses auto `GITHUB_TOKEN` + `PROWL_AI_KEY` secret.
    - Acceptance: dogfooded on a real code repo (e.g. `prowl`) — a PR with a deliberate cross-file bug surfaces it inline with a suggestion.

## Medium Priority

11. **Linter / SAST grounding**
    As a reviewer, I want deterministic linter/SAST findings fed into the review, so that mechanical issues are caught and the LLM hallucinates less.
    - Acceptance: run available linters on changed files in parallel (ESLint, Ruff, Semgrep, Gitleaks — auto-selected by language), normalize to the findings schema.
    - Acceptance: results injected into the prompt as grounding signals; LLM reconciles (confirm/dismiss) rather than re-discovering them.

12. **Update-not-duplicate + resolve outdated threads**
    As a developer, I want re-runs to update the existing review instead of stacking new ones, so that the PR stays clean across pushes.
    - Acceptance: find the bot's prior review/summary by author and PATCH it; post only net-new inline findings.
    - Acceptance: mark fixed/outdated inline threads resolved via GraphQL `resolveReviewThread`.

13. **Incremental re-review on new commits**
    As a developer, I want pushes to an open PR to review only the new changes without repeating prior findings, so that re-reviews are fast and cheap.
    - Acceptance: on `synchronize`, review only the delta since the last reviewed SHA (persisted via marker comment or check); previously-posted findings are not repeated.

14. **Check run / merge gate**
    As an org owner, I want a pass/fail status check with line annotations, so that critical findings can block merge.
    - Acceptance: create a Check Run (Checks API) with `conclusion` from severity (e.g. Critical → failure) + summary + up to 50 annotations/batch; configurable gating.

15. **`@prowl-review` chat replies**
    As a developer, I want to mention the bot in a PR comment and get a contextual, in-thread reply, so that I can ask follow-ups.
    - Acceptance: `respond` command + Action triggers on `issue_comment` / `pull_request_review_comment` containing `@prowl-review`; reply threads correctly with PR/diff context.

16. **`.prowl-review.yml` config + `init` command**
    As a developer, I want a per-repo config, so that I can tune providers/models, specialist passes, severity threshold, path filters, risk-tiering, tone, and ignore globs.
    - Acceptance: Zod-validated loader (style of `prowl/src/config/schema.ts`); documented defaults; `prowl-review init` scaffolds a commented config.

17. **Risk-tiered orchestration (cost control)**
    As a developer, I want small diffs to run fewer passes and large/complex ones to run more, so that cost scales with risk.
    - Acceptance: pass-count/model tier selected from diff size/complexity (config-overridable); the chosen tier and est. cost are logged.

18. **Explicit guidelines + learnings files (the OSS replacement for CodeRabbit "learnings")**
    As a team, I want version-controlled review guidelines and a learned-patterns file, so that the reviewer is tuned to us and stops repeating known false positives.
    - Acceptance: reviewer loads `CLAUDE.md`/`REVIEW_GUIDELINES.md` (what to check) and a `LEARNED_PATTERNS.md` (known false positives / must-catch patterns) into the prompt.
    - Acceptance: a documented feedback path (e.g. 👎 reaction or `@prowl-review ignore`) appends to the learned-patterns file.

19. **Local pre-push CLI mode**
    As a developer, I want to run the same reviewer locally against a branch/diff before pushing, so that I get two layers of review with no extra tooling.
    - Acceptance: `prowl-review review --base <ref> --head <ref>` prints findings (severity, file:line, suggestion) to the terminal without GitHub.

20. **Token-usage + cost logging**
    As a developer, I want per-review token/cost output (incl. cache hits), so that I can confirm I'm paying cents and there's no per-hour cap.
    - Acceptance: logs input/output/cached tokens and estimated cost per provider per run.

21. **Reusable org-level workflow**
    As an org owner, I want one reusable workflow referenced by all repos, so that "across all my projects" needs no YAML copy-paste.
    - Acceptance: documented `workflow_call` workflow (intended for `Prowl-qa/.github`) that any repo invokes in a few lines.

22. **Document the auth policy (BYOK default; Codex the only subscription exception)**
    As a user, I want clear docs on how `prowl-review` authenticates to each provider, so that I understand the cost model and avoid TOS/account-ban risk.
    - Acceptance: README + `prowl-docs` state the policy — **BYO API key for every configurable provider** (Claude, OpenAI, Gemini); we never store/proxy keys.
    - Acceptance: state that **subscription routing is supported for OpenAI/Codex only** (opt-in; see item 27) and **not** for Claude or Gemini — directly reusing their subscription OAuth in a third-party tool is prohibited and gets accounts banned (Anthropic Consumer Terms §3.7; Google Feb-2026 bans; OpenClaw is the precedent). Explain *why*.

## Low Priority

23. **Suggested-fix validation**
    As a developer, I want auto-fix suggestions verified before they're posted, so that one-click commits don't break the build.
    - Acceptance: only generate ```suggestion``` for high-confidence findings; optionally apply-and-typecheck/lint the fix in a sandbox before including it.

24. **npm + Homebrew distribution**
    As a user, I want to install via npm or `brew`, so that adoption matches the rest of Prowl QA.
    - Acceptance: published `prowl-review` npm package; `Formula/prowl-review.rb` added to `homebrew-tap` (pulls npm tarball, Apache-2.0, node@20).

25. **Docs + marketing integration**
    As a prospective user, I want docs and a landing section, so that I can discover and set up the tool.
    - Acceptance: `docs/code-review.md` + sidebar entry in `prowl-docs`; a code-review section + install snippet in `prowl-web`; raccoon/brand conventions; "made for agents, controlled by humans" framing.

26. **Retire/replace baseline Anthropic workflows**
    As a maintainer, I want to remove the placeholder `claude-code-action` workflows once `prowl-review` reaches parity, so that the repo dogfoods its own tool.
    - Acceptance: replace `.github/workflows/claude-code-review.yml` after inline reviews (item 9) land; revisit `claude.yml` after `@prowl-review` chat (item 15) lands.

27. **Optional OpenAI/Codex subscription backend (documented opt-in feature)**
    As a developer already paying for ChatGPT, I want an opt-in Codex-subscription backend, so that I can run reviews on my existing OpenAI plan instead of buying separate API credits.
    - Acceptance: **OpenAI/Codex only.** A documented feature, **off by default**, enabled via an explicit config flag.
    - Acceptance: docs flag it as relying on Codex's subscription auth, against OpenAI's reverse-engineering clause, tolerated-but-not-sanctioned, and liable to break/trigger enforcement; not recommended as the default for automated org-wide CI.
    - Acceptance: **isolated behind the provider abstraction** so it can be removed cleanly if OpenAI blocks it; never the default; no equivalent path for Claude/Gemini.

28. **Phase 2 — Hosted GitHub App (install-once)**
    As a user, I want an install-once app covering all repos/orgs automatically, so that I get CodeRabbit's managed UX without per-repo workflows.
    - Acceptance: design doc for a webhook service wrapping the same TS core (Vercel route or homelab) + GitHub App registration; optional Next.js dashboard reusing `prowl-hub` patterns. Deferred until the Action path is proven.

29. **Watch & adopt delegated-API OAuth if a provider ships it**
    As a maintainer, I want to track providers' delegated-API OAuth and adopt it when available, so that users eventually get one-click, TOS-compliant, subscription-aware auth.
    - Acceptance: tracking note records that no provider offers delegated-API OAuth as of 2026-06 (OpenAI "Sign in with ChatGPT" = identity only).
    - Acceptance: when a real authorization-code flow yielding delegated API access (billed to the user's own account) ships, add it as a first-class auth option behind the provider abstraction.

## Completed
