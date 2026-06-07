# Backlog

Prioritized list of planned features, improvements, and technical debt for **`prowl-review`** — a BYOK (bring-your-own-key) AI code-review tool for the Prowl QA suite. Delivered first as a GitHub Action + local CLI in TypeScript, reusing `prowl`'s toolchain and the provider abstraction from `prowl/src/generator/ai.ts`. Multi-provider (Claude default / OpenAI / Gemini). Apache-2.0.

**Positioning (why we're building, not just tuning Claude Code's review):** a single-pass, diff-only LLM review (what Claude Code and Codex do today) misses the bugs that live in the seam between changed code and its callers, and it *reads* like a wall of text. The paid tools (CodeRabbit, Greptile, Qodo) win on four techniques + presentation, all replicable BYOK: (1) **cross-file context** via **agentic retrieval** (grep/read on demand — NOT a vector DB), (2) **multi-pass specialized review + a judge/dedup pass**, (3) **linter/SAST grounding**, (4) **false-positive verification**; plus a **structured walkthrough + committable inline suggestions**. Cost is managed via **prompt caching** + **risk-tiered** agent counts, so per-review stays in cents — still far under CodeRabbit's ~$576/yr for this user.

User stories use **As a `<role>`, I want `<capability>`, so that `<value>`.** Each carries acceptance criteria.

When an item is completed, move it to `## Completed` with `(completed: YYYY-MM-DD)` so done work is recorded without losing history.

## High Priority

1. **TypeScript package scaffold matching `prowl`**
   As a maintainer, I want a new TS package (`prowl-review`) wired with prowl's exact toolchain, so that the reviewer is consistent with the suite and easy to ship.
   - Acceptance: `package.json` (name `prowl-review`, `bin`, scripts), `tsup.config.ts`, `tsconfig.json` (strict, ESM), `.eslintrc.cjs`, Vitest — copied/adapted from `prowl`.
   - Acceptance: `npm run build` produces a runnable `dist/cli.js`; `npx prowl-review --help` prints commands. Apache-2.0 LICENSE + NOTICE present.

2. **Multi-provider BYOK LLM abstraction + prompt caching**
   As a developer, I want to pick Claude, OpenAI, or Gemini via env vars with caching built in, so that I'm never vendor-locked and reviews stay cheap.
   - Acceptance: `providers/` exposes one interface; selection via `PROWL_AI_PROVIDER` (default `anthropic`) + `PROWL_AI_KEY`, mirroring `prowl/src/generator/ai.ts`. Sane default models (stronger for the judge, cheaper for specialist passes).
   - Acceptance: **prompt caching** wired so stable content (system prompt, guidelines, fetched repo context, tool defs) is cached and only the diff is uncached; cache-aware token accounting.
   - Acceptance: unit tests for provider selection, missing-key error, and cache-block construction (`fetch` mocked).

3. **Diff fetch + parsing with size guards**
   As a developer, I want the tool to fetch a PR's diff and parse it into files/hunks/lines, so that reviews target real changed code and inline comments map to exact lines.
   - Acceptance: `github/diff.ts` fetches PR diff + metadata via Octokit; `review/parse-diff.ts` maps hunks to `path` + new-side line numbers/ranges.
   - Acceptance: config caps (`maxFiles`, `maxDiffBytes`) chunk/skip oversized diffs; skipped content reported, never silently dropped.

4. **Agentic cross-file context retrieval (the #1 bug-catching lever)**
   As a reviewer, I want the agent to pull in callers, callees, and related files of changed code on demand, so that it catches broken callers, contract/interface violations, and inconsistent patterns that diff-only review misses.
   - Acceptance: the review agent has **read-file + grep/search tools** over the checked-out repo and decides what to fetch (agentic retrieval) — **no vector DB / embeddings**.
   - Acceptance: for each changed export/function, the agent can locate and read its callers/definition sites; fetched context added to the (cached) prompt; bounded by config and reported.

5. **Multi-language support**
   As a developer on any stack, I want context retrieval and linting to work beyond JS/TS, so that `prowl-review` is a real CodeRabbit replacement (and covers the Prowl suite's Python/YAML too).
   - Acceptance: language-agnostic parsing via tree-sitter grammars (TS/JS, Python, Go, Ruby, Java, etc.) feeding caller/definition lookup for #4.
   - Acceptance: per-language linter auto-selection in grounding (#16); graceful degradation for unsupported languages (still reviews via the LLM, just without AST-assisted context).

6. **Multi-pass specialized review + judge/dedup pass**
   As a reviewer, I want several focused passes (correctness, security, performance, tests) merged by a judge, so that diverse lenses catch more and a single clean result is produced.
   - Acceptance: N specialist passes run in parallel, each with a tightly-scoped prompt; configurable set.
   - Acceptance: a **judge pass** dedups (hash of file+line+category), re-categorizes, drops nitpicks/speculation, ranks by severity; shared context written once and referenced (avoid N× token blow-up). Unit tests for dedup/merge.

7. **Findings schema (severity + confidence) + review prompts**
   As a developer, I want structured, severity- and confidence-tagged findings, so that output is consistent, filterable, and machine-mappable to comments.
   - Acceptance: Zod schema — `file`, `line`/range, `severity` (Critical/Major/Minor/Trivial/Info), `confidence` (0–1), `category`, `title`, `body`, optional `suggestion`.
   - Acceptance: specialist + judge prompts in `review/prompt.ts`, built from diff + fetched context; providers return validated findings (retry on malformed).

8. **False-positive verification pass**
   As a developer, I want low-confidence findings re-checked skeptically before posting, so that the review is high-signal and not naggy.
   - Acceptance: findings below a confidence threshold get a second "is this actually a bug?" pass that can demote/drop them; severity threshold + dedup applied before posting; counts of dropped findings logged.

9. **Structured walkthrough summary (presentation)**
   As a reviewer, I want a clean PR walkthrough comment, so that the review reads premium instead of a text wall.
   - Acceptance: one summary body with plain-language summary, **Impact + estimated-effort** badges, grouped/layered changed-files overview, and severity counts.
   - Acceptance: optional **Mermaid** sequence/flow diagram when the PR affects a clear flow (feature-flagged; degrade gracefully).

10. **Inline comments with committable suggestions (presentation)**
    As a reviewer, I want findings posted inline on exact lines with one-click fixes, so that it feels like CodeRabbit/Greptile and I can apply fixes instantly.
    - Acceptance: a **single cohesive published review** (`POST .../pulls/{n}/reviews`) with `event: COMMENT` (or an explicit submit-review step), summary body, and `comments[]` mapped to `path`/`line`/`side` (multi-line ranges supported).
    - Acceptance: each finding renders a **severity badge** + a committable GitHub `suggestion` block when a safe fix exists; findings outside the diff fall back to the summary.

11. **GitHub Action wrapper + dogfood**
    As a developer, I want a drop-in Action, so that adding one workflow file + an API-key secret enables premium reviews on any repo with no hosting.
    - Acceptance: `action.yml` defines the Node action metadata (`inputs`, `outputs`, and `runs`) and invokes the full pipeline.
    - Acceptance: sample `.github/workflows/prowl-review.yml` triggers on `pull_request` [opened, synchronize, ready_for_review, reopened], declares `permissions: pull-requests: write, checks: write, contents: read`, checks out the repository with `actions/checkout` before invoking `prowl-review`, and uses auto `GITHUB_TOKEN` + `PROWL_AI_KEY` secret.
    - Acceptance: dogfooded on a real code repo (e.g. `prowl`) — a PR with a deliberate cross-file bug surfaces it inline with a suggestion.

12. **Review state persistence strategy**
    As a maintainer, I want a defined place to persist per-PR state in a stateless Action, so that incremental review, update-not-duplicate, and learnings actually work.
    - Acceptance: decide and implement a store for last-reviewed SHA, already-posted findings, and learnings (e.g. a hidden marker comment and/or a `.prowl-review/` artifact); documented and reused by #22/#21/#30.

13. **Quality eval harness**
    As a maintainer, I want to score the reviewer against a fixed benchmark of PRs-with-known-bugs, so that I can tune prompts/passes and *prove* parity with CodeRabbit/Greptile instead of guessing.
    - Acceptance: a curated benchmark set (seeded real bugs + clean PRs) and a runner that computes precision/recall/F1 and false-positive rate.
    - Acceptance: results are reproducible per prompt/model version; regressions are visible before release.

14. **Security hardening: prompt-injection resistance + agent tool sandboxing**
    As a maintainer, I want the reviewer hardened against malicious PR content, so that an untrusted diff/comment can't hijack the review, its retrieval tools, or its commands.
    - Acceptance: all PR content (diff, code, comments, titles, branch names) is treated as untrusted **data, not instructions**; the system prompt enforces this; detected injection attempts are ignored and may be surfaced as a finding.
    - Acceptance: the agentic retrieval tools (#4) are confined to the repo checkout — no reads outside the workspace, no network exfiltration; bot commands (#24) authorize only a known verb allowlist.

15. **Secret redaction before sending context to the provider**
    As a privacy-conscious user, I want secrets stripped from anything sent to the LLM, so that BYOK never leaks my credentials to the provider.
    - Acceptance: redact obvious secrets (API keys, tokens, `.env` contents, private keys) from diffs and fetched context before they enter any prompt; reuse secret-detection patterns (e.g. Gitleaks rules).
    - Acceptance: known-sensitive files skipped by default; redactions are logged by count only — never the secret value.

## Medium Priority

16. **Linter / SAST grounding**
    As a reviewer, I want deterministic linter/SAST findings fed into the review, so that mechanical issues are caught and the LLM hallucinates less.
    - Acceptance: run available linters on changed files in parallel (ESLint, Ruff, Semgrep, Gitleaks — auto-selected by language per #5), normalize to the findings schema, inject as grounding signals; LLM reconciles rather than re-discovers.

17. **LLM resilience: retry/backoff + partial-failure handling**
    As a developer, I want reviews to survive provider hiccups, so that a transient 429 or one failed pass doesn't kill the whole review.
    - Acceptance: exponential backoff + jitter on 429/5xx; a failed specialist pass degrades gracefully (judge proceeds with the rest) and is reported.

18. **Per-PR budget cap**
    As a developer, I want a max-spend ceiling per review, so that a huge PR can't quietly cost me real money.
    - Acceptance: configurable token/cost cap; when exceeded, the tool trims scope (or posts a "review truncated — raise the cap" note) instead of running unbounded.

19. **Default ignore list**
    As a developer, I want generated/vendored files ignored by default, so that reviews aren't noisy or expensive.
    - Acceptance: sensible built-in ignores (lockfiles, `dist/`/`build/`, snapshots, `node_modules`, vendored dirs), overridable via config.

20. **Fork-PR handling / security model**
    As an OSS maintainer, I want defined behavior on fork PRs, so that the tool degrades safely when secrets and write tokens aren't available.
    - Acceptance: detect fork PRs (read-only token / no `PROWL_AI_KEY`); fall back to a documented mode (e.g. summary-only via `pull_request_target` guidance, or skip with a clear message). No secret leakage to fork code.

21. **Workflow concurrency control**
    As a developer who pushes often, I want superseded reviews cancelled, so that rapid re-pushes don't spawn overlapping reviews that race to comment.
    - Acceptance: the Action/workflow uses a `concurrency` group keyed to the PR with `cancel-in-progress`; in-flight reviews for an outdated SHA are cancelled cleanly.

22. **Update-not-duplicate + resolve outdated threads**
    As a developer, I want re-runs to update the existing review instead of stacking new ones, so that the PR stays clean across pushes.
    - Acceptance: find the prior prowl-review summary by a prowl-specific marker or stored review id (with author as a secondary check only), then update it via REST `PUT /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}` or the matching GraphQL mutation; post only net-new inline findings; mark fixed/outdated threads resolved via GraphQL `resolveReviewThread`.

23. **Incremental re-review on new commits**
    As a developer, I want pushes to an open PR to review only the new changes without repeating prior findings, so that re-reviews are fast and cheap.
    - Acceptance: on `synchronize`, review only the delta since the last reviewed SHA (from #12); previously-posted findings not repeated.

24. **Check run / merge gate**
    As an org owner, I want a pass/fail status check with line annotations, so that critical findings can block merge.
    - Acceptance: create a Check Run (Checks API) with `conclusion` from severity (e.g. Critical → failure) + summary + up to 50 annotations/batch; configurable gating.

25. **Inline-comment volume cap (noise ceiling)**
    As a developer, I want a cap on inline comments per review, so that a large PR isn't carpet-bombed with comments.
    - Acceptance: configurable max inline comments (sensible default); overflow findings roll into the summary grouped by severity/file; the cap and overflow count are reported.

26. **Bot command set**
    As a developer, I want chat commands to control the reviewer, so that I can drive it from the PR like CodeRabbit.
    - Acceptance: support `review` / `full review` (manual + full re-scan), `pause`/`resume`, `ignore`, `resolve`, `configure` via `@prowl-review <cmd>` comments (verb allowlist per #14).

27. **`@prowl-review` chat replies**
    As a developer, I want to mention the bot in a PR comment and get a contextual, in-thread reply, so that I can ask follow-ups.
    - Acceptance: `respond` command + Action triggers on `issue_comment` / `pull_request_review_comment` containing `@prowl-review`; reply threads correctly with PR/diff context.

28. **Draft-PR & auto-review controls**
    As a developer, I want control over when reviews fire, so that drafts are my buffer.
    - Acceptance: skip drafts until "ready for review" by default; config toggle for auto-review vs. on-demand (`@prowl-review review`) only.

29. **`.prowl-review.yml` config + `init` command**
    As a developer, I want a per-repo config, so that I can tune providers/models, specialist passes, severity threshold, path filters/instructions, risk-tiering, tone, ignore globs, and the comment cap.
    - Acceptance: Zod-validated loader (style of `prowl/src/config/schema.ts`); documented defaults; `prowl-review init` scaffolds a commented config.

30. **Explicit guidelines + learnings files (the OSS replacement for CodeRabbit "learnings")**
    As a team, I want version-controlled review guidelines and a learned-patterns file, so that the reviewer is tuned to us and stops repeating known false positives.
    - Acceptance: reviewer loads `CLAUDE.md`/`REVIEW_GUIDELINES.md` and a `LEARNED_PATTERNS.md` into the prompt; a documented feedback path (👎 reaction or `@prowl-review ignore`) appends to learned-patterns (persisted per #12).

31. **Risk-tiered orchestration (cost control)**
    As a developer, I want small diffs to run fewer passes and large/complex ones more, so that cost scales with risk.
    - Acceptance: pass-count/model tier selected from diff size/complexity (config-overridable); chosen tier + est. cost logged.

32. **Issue/ticket validation**
    As a developer, I want the reviewer to check whether the PR satisfies its linked issue, so that scope gaps are caught early.
    - Acceptance: when a PR links a GitHub issue (and optionally Linear/Jira), pull the issue's acceptance criteria into the review and flag unmet/missing requirements.

33. **Finishing touches: PR description / docstring / test generation**
    As a developer, I want the reviewer to draft the PR description and offer docstrings/unit tests, so that I get CodeRabbit-style assists.
    - Acceptance: auto-generate/update a PR description from the diff (opt-in); commands to generate docstrings and unit-test stubs for changed code.

34. **Dependency-CVE / license scanning**
    As a security-conscious developer, I want changed dependencies checked for known CVEs and license issues, so that risky deps are flagged in review.
    - Acceptance: detect dependency-manifest changes; surface known-vuln advisories and license-policy violations as findings.

35. **Local pre-push CLI mode**
    As a developer, I want to run the same reviewer locally against a branch/diff before pushing, so that I get two layers of review with no extra tooling.
    - Acceptance: `prowl-review review --base <ref> --head <ref>` prints findings (severity, file:line, suggestion) to the terminal without GitHub.

36. **Token-usage + cost logging**
    As a developer, I want per-review token/cost output (incl. cache hits), so that I can confirm I'm paying cents and there's no per-hour cap.
    - Acceptance: logs input/output/cached tokens and estimated cost per provider per run.

37. **Reusable org-level workflow**
    As an org owner, I want one reusable workflow referenced by all repos, so that "across all my projects" needs no YAML copy-paste.
    - Acceptance: documented `workflow_call` workflow (intended for `Prowl-qa/.github`) that any repo invokes in a few lines.

38. **Document the auth policy (BYOK default; Codex the only subscription exception)**
    As a user, I want clear docs on how `prowl-review` authenticates to each provider, so that I understand the cost model and avoid TOS/account-ban risk.
    - Acceptance: README + `prowl-docs` state the policy — **BYO API key for every configurable provider** (Claude, OpenAI, Gemini); we never store/proxy keys.
    - Acceptance: state that **subscription routing is supported for OpenAI/Codex only** (opt-in; see the Codex-subscription backend item) and **not** for Claude or Gemini — directly reusing their subscription OAuth in a third-party tool is prohibited and gets accounts banned (Anthropic Consumer Terms §3.7; Google Feb-2026 bans; OpenClaw is the precedent). Explain *why*.

## Low Priority

39. **Suggested-fix validation**
    As a developer, I want auto-fix suggestions verified before they're posted, so that one-click commits don't break the build.
    - Acceptance: only generate `suggestion` blocks for high-confidence findings; optionally apply-and-typecheck/lint the fix in a sandbox before including it.

40. **Data-privacy positioning**
    As a privacy-conscious user, I want it documented that my code only ever goes to my own provider, so that I trust the tool over hosted SaaS.
    - Acceptance: doc + landing point — BYOK means we never see/store code or keys; inference goes directly from the user's runner to the user's chosen provider (paired with secret redaction, #15).

41. **Repo hygiene & demo**
    As a prospective contributor/user, I want a polished OSS repo, so that the project is credible and easy to adopt.
    - Acceptance: `CONTRIBUTING.md`, `SECURITY.md`, an example/demo repo, a demo GIF/screenshots, and a documented telemetry-opt-in (default off) policy.

42. **npm + Homebrew distribution**
    As a user, I want to install via npm or `brew`, so that adoption matches the rest of Prowl QA.
    - Acceptance: published `prowl-review` npm package; `Formula/prowl-review.rb` added to `homebrew-tap` (pulls npm tarball, Apache-2.0, node@20).

43. **Docs + marketing integration**
    As a prospective user, I want docs and a landing section, so that I can discover and set up the tool.
    - Acceptance: `docs/code-review.md` + sidebar entry in `prowl-docs`; a code-review section + install snippet in `prowl-web`; raccoon/brand conventions; "made for agents, controlled by humans" framing.

44. **Retire/replace baseline Anthropic workflows**
    As a maintainer, I want to remove the placeholder `claude-code-action` workflows once `prowl-review` reaches parity, so that the repo dogfoods its own tool.
    - Acceptance: replace `.github/workflows/claude-code-review.yml` after inline reviews land; revisit `claude.yml` after `@prowl-review` chat lands.

45. **Optional OpenAI/Codex subscription backend (documented opt-in feature)**
    As a developer already paying for ChatGPT, I want an opt-in Codex-subscription backend, so that I can run reviews on my existing OpenAI plan instead of buying separate API credits.
    - Acceptance: implementation is blocked until documented Legal/Compliance sign-off is obtained and recorded.
    - Acceptance: **OpenAI/Codex only.** Documented, **off by default**, enabled via an explicit flag; flagged as relying on Codex's subscription auth, against OpenAI's reverse-engineering clause, tolerated-but-not-sanctioned, liable to break/trigger enforcement; not recommended for automated org-wide CI.
    - Acceptance: **isolated behind the provider abstraction** so it can be removed cleanly if OpenAI blocks it; never the default; no equivalent path for Claude/Gemini.
    - Acceptance: **model backend only** — this uses Codex as an inference engine, NOT OpenAI's first-party "Codex in GitHub" app (`chatgpt-codex-connector`). We never route through that bot; the prompt, multi-pass pipeline, and presentation are `prowl-review`'s own, and comments post under our identity (`github-actions[bot]`, later `prowl-review[bot]`) — never as the Codex connector. Documented so users don't expect the canned "Codex Review" output.

46. **SCM breadth (GitLab / Bitbucket) — deferred to post-v1**
    As a non-GitHub user, I want the reviewer to work on GitLab/Bitbucket eventually, so that the tool isn't GitHub-locked.
    - Acceptance: explicitly **deferred** — recorded as a conscious post-v1 decision; revisit after the GitHub Action path is proven. Provider/SCM seams kept clean enough not to preclude it.

47. **Phase 2 — Hosted GitHub App (install-once)**
    As a user, I want an install-once app covering all repos/orgs automatically, so that I get CodeRabbit's managed UX without per-repo workflows.
    - Acceptance: design doc for a webhook service wrapping the same TS core (Vercel route or homelab) + GitHub App registration; optional Next.js dashboard reusing `prowl-hub` patterns. Deferred until the Action path is proven.

48. **Watch & adopt delegated-API OAuth if a provider ships it**
    As a maintainer, I want to track providers' delegated-API OAuth and adopt it when available, so that users eventually get one-click, TOS-compliant, subscription-aware auth.
    - Acceptance: tracking note records that no provider offers delegated-API OAuth as of 2026-06 (OpenAI "Sign in with ChatGPT" = identity only).
    - Acceptance: when a real authorization-code flow yielding delegated API access (billed to the user's own account) ships, add it as a first-class auth option behind the provider abstraction.

49. **Debug/verbose mode**
    As a maintainer tuning the reviewer, I want to inspect what a run actually did, so that I can diagnose odd reviews.
    - Acceptance: a verbose flag emits the assembled prompts, fetched-context list, raw findings (pre/post judge + verification), and token/cost breakdown — without leaking secrets (respects #15).

## Completed
