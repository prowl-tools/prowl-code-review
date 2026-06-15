# Backlog

Prioritized list of planned features, improvements, and technical debt for **`prowl-review`** — a BYOK (bring-your-own-key) AI code-review tool for the Prowl QA suite. Delivered first as a GitHub Action + local CLI in TypeScript, reusing `prowl`'s toolchain and the provider abstraction from `prowl/src/generator/ai.ts`. Multi-provider (Claude default / OpenAI / Gemini). Apache-2.0.

**Positioning (why we're building, not just tuning Claude Code's review):** a single-pass, diff-only LLM review (what Claude Code and Codex do today) misses the bugs that live in the seam between changed code and its callers, and it *reads* like a wall of text. The paid tools (CodeRabbit, Greptile, Qodo) win on four techniques + presentation, all replicable BYOK: (1) **cross-file context** via **agentic retrieval** (grep/read on demand — NOT a vector DB), (2) **multi-pass specialized review + a judge/dedup pass**, (3) **linter/SAST grounding**, (4) **false-positive verification**; plus a **structured walkthrough + committable inline suggestions**. Cost is managed via **prompt caching** + **risk-tiered** agent counts, so per-review stays in cents — still far under CodeRabbit's ~$576/yr for this user.

User stories use **As a `<role>`, I want `<capability>`, so that `<value>`.** Each carries acceptance criteria.

When an item is completed, move it to [`docs/resolved.md`](./resolved.md) with `(completed: YYYY-MM-DD)` and remove it here; keep the remaining items' numbers stable (don't renumber) so references stay valid.

## High Priority

5. **Multi-language support**
   As a developer on any stack, I want context retrieval and linting to work beyond JS/TS, so that `prowl-review` is a real CodeRabbit replacement (and covers the Prowl suite's Python/YAML too).
   - Acceptance: language-agnostic parsing via tree-sitter grammars (TS/JS, Python, Go, Ruby, Java, etc.) feeding caller/definition lookup for #4.
   - Acceptance: per-language linter auto-selection in grounding (#16); graceful degradation for unsupported languages (still reviews via the LLM, just without AST-assisted context).

## Medium Priority

16b. **More grounding runners: Gitleaks / Semgrep / Ruff** *(framework + ESLint done — see resolved.md)*
    As a reviewer, I want SAST + more-language linters fed into the review too, so that grounding isn't JS/TS-only.
    - Acceptance: add Gitleaks (secrets), Semgrep (SAST, rule-configurable), and Ruff (Python) as runners in the existing `src/grounding` registry, normalized to the findings schema and injected as grounding alongside ESLint.
    - Acceptance: per-language linter auto-selection generalizes with #5's language detection; graceful degradation when a tool is absent (already in place).

17. **LLM resilience: cross-generation failback + heartbeat** *(retry/backoff + partial-failure done — see resolved.md)*
    As a developer, I want reviews to survive sustained provider trouble and long "thinking", so that overload or a slow model doesn't kill or appear to hang the review.
    - **Done:** exponential backoff + jitter on 429/408/425/5xx/network across specialist passes, verification, and context retrieval; a failed specialist pass already degrades gracefully and is reported (#56 surfaces it).
    - Acceptance: per-model-family failback (fall back to an older generation on persistent overload, not across providers); failback only on retryable errors (429/503) after retries are exhausted.
    - Acceptance: heartbeat progress logs so long model "thinking" isn't mistaken for a hung job (wire the existing `onRetry` hook + a periodic tick).

20. **Fork-PR handling / security model**
    As an OSS maintainer, I want defined behavior on fork PRs, so that the tool degrades safely when secrets and write tokens aren't available.
    - Acceptance: detect fork PRs (read-only token / no `PROWL_AI_KEY`); fall back to a documented mode (e.g. summary-only via `pull_request_target` guidance, or skip with a clear message). No secret leakage to fork code.

21. **Workflow concurrency control**
    As a developer who pushes often, I want superseded reviews cancelled, so that rapid re-pushes don't spawn overlapping reviews that race to comment.
    - Acceptance: the Action/workflow uses a `concurrency` group keyed to the PR with `cancel-in-progress`; in-flight reviews for an outdated SHA are cancelled cleanly.

22. **Update-not-duplicate: resolve outdated threads + respect human replies** *(core done — see resolved.md)*
    As a developer, I want re-runs to also tidy up stale threads and honor my replies, so that the PR stays clean and the bot isn't argumentative.
    - **Done (core):** the summary is found by marker and updated in place (now a top-level PR comment, not a stacked review); only net-new inline findings are posted (deduped via the #12 state fingerprints).
    - Acceptance: mark fixed/outdated finding threads resolved via GraphQL `resolveReviewThread` when their finding no longer appears (or its line is gone).
    - Acceptance: respect human replies on a finding — "won't fix"/"acknowledged" resolves the thread; "I disagree" makes the judge justify the finding or withdraw it (instead of blindly re-emitting it).

23. **Incremental re-review on new commits**
    As a developer, I want pushes to an open PR to review only the new changes without repeating prior findings, so that re-reviews are fast and cheap.
    - Acceptance: on `synchronize`, review only the delta since the last reviewed SHA (from #12); previously-posted findings not repeated.

24. **Check run / merge gate**
    As an org owner, I want a pass/fail status check with line annotations, so that critical findings can block merge.
    - Acceptance: create a Check Run (Checks API) with `conclusion` from severity (e.g. Critical → failure) + summary + up to 50 annotations/batch; configurable gating.

26. **Bot command set**
    As a developer, I want chat commands to control the reviewer, so that I can drive it from the PR like CodeRabbit.
    - Acceptance: support `review` / `full review` (manual + full re-scan), `pause`/`resume`, `ignore`, `resolve`, `configure` via `@prowl-review <cmd>` comments (verb allowlist per #14).

27. **`@prowl-review` chat replies**
    As a developer, I want to mention the bot in a PR comment and get a contextual, in-thread reply, so that I can ask follow-ups.
    - Acceptance: `respond` command + Action triggers on `issue_comment` / `pull_request_review_comment` containing `@prowl-review`; reply threads correctly with PR/diff context.

28. **Draft-PR & auto-review controls**
    As a developer, I want control over when reviews fire, so that drafts are my buffer.
    - Acceptance: skip drafts until "ready for review" by default; config toggle for auto-review vs. on-demand (`@prowl-review review`) only.

30. **Explicit guidelines + learnings files (the OSS replacement for CodeRabbit "learnings")**
    As a team, I want version-controlled review guidelines and a learned-patterns file, so that the reviewer is tuned to us and stops repeating known false positives.
    - Acceptance: reviewer loads `CLAUDE.md`/`REVIEW_GUIDELINES.md` and a `LEARNED_PATTERNS.md` into the prompt; a documented feedback path (👎 reaction or `@prowl-review ignore`) appends to learned-patterns (persisted per #12).
    - Acceptance: support an optional **org-wide guidelines template** (a shared file or URL injected into every repo's prompts) in addition to per-repo files, so orgs can enforce house standards once.

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

37. **Reusable org-level workflow**
    As an org owner, I want one reusable workflow referenced by all repos, so that "across all my projects" needs no YAML copy-paste.
    - Acceptance: documented `workflow_call` workflow (intended for `Prowl-qa/.github`) that any repo invokes in a few lines.

38. **Document the auth policy (BYOK default; Codex the only subscription exception)**
    As a user, I want clear docs on how `prowl-review` authenticates to each provider, so that I understand the cost model and avoid TOS/account-ban risk.
    - Acceptance: README + `prowl-docs` state the policy — **BYO API key for every configurable provider** (Claude, OpenAI, Gemini); we never store/proxy keys.
    - Acceptance: state that **subscription routing is supported for OpenAI/Codex only** (opt-in; see the Codex-subscription backend item) and **not** for Claude or Gemini — directly reusing their subscription OAuth in a third-party tool is prohibited and gets accounts banned (Anthropic Consumer Terms §3.7; Google Feb-2026 bans; OpenClaw is the precedent). Explain *why*.

52. **Approval rubric + break-glass override**
    As a developer, I want a predictable severity→decision rubric and an escape hatch, so that the gate behaves consistently and never blocks me against my judgment.
    - Acceptance: map findings to a GitHub review event — any Critical → request changes; only suggestions/none → comment or approve (configurable thresholds), wired to #24's check conclusion.
    - Acceptance: a `@prowl-review break glass` (override) comment force-approves past a blocking finding and is recorded in the review for auditability (Cloudflare saw this used in ~0.6% of MRs — rare, but it keeps humans in control).

53. **Multi-provider ensemble review + cross-provider consensus**
    As a developer with more than one provider key, I want the same changes reviewed by multiple providers at once with their findings consolidated, so that I get cross-model consensus and more granular, higher-confidence insight — a BYOK-only edge that resale-based reviewers (CodeRabbit/Greptile) can't offer.
    - Acceptance: **opt-in, default off.** Per-provider keys (e.g. `PROWL_AI_KEY_ANTHROPIC`/`_OPENAI`/`_GEMINI`) + a configured provider list; an ensemble orchestrator runs `runReview` (the #6 pipeline) per available provider **in parallel** and pools the raw findings.
    - Acceptance: the judge consolidates duplicates **across providers**, recording provenance (`sources: [...]`) and treating agreement as a confidence boost; single-provider findings are kept but marked.
    - Acceptance: presentation surfaces a **consensus badge** (e.g. "🤝 agreed by N/M providers") in the walkthrough + inline comments — the granular insight.
    - Acceptance: **cost-guarded** — costs ~N× a single-provider review (caching helps within each provider, not across); respects the per-PR budget cap (#18) and risk-tiering (#31); docs state the multiplier. Complements false-positive verification (#8): cross-provider agreement is itself a verification signal.

54. **Review comment presentation polish (visual design)**
    As a developer reading a review, I want the comment to look premium and scannable (CodeRabbit/Greptile-grade), so that it's pleasant rather than a flat wall of text.
    - Acceptance: use **collapsible `<details>`** for long/secondary sections (changed-files, review notes) so the summary stays short by default.
    - Acceptance: **condense the changed-files overview** — a count + a collapsed `<details>` (or a tight table), never a bullet-per-file wall (the current 15-file list reads as noise); when there are few/no findings, the whole comment stays short and skimmable rather than a long scroll.
    - Acceptance: use GitHub **alert blocks** (`> [!NOTE]` / `> [!WARNING]` / `> [!CAUTION]`) for impact + review-notes instead of plain emoji lines; render findings as a compact **table** (severity badge · location · title) rather than a flat list.
    - Acceptance: clean header + consistent severity/impact badges + a one-line TL;DR; an estimated-effort visual (e.g. `▰▰▰▱▱`); degrade-safe (still renders if a feature is unsupported).
    - Acceptance: pure-formatter changes to `buildWalkthrough` (#9) and inline (#10), covered by tests; benchmarked visually against CodeRabbit/Greptile for "premium feel." (Bot avatar/branding is separate — see #47.)


39. **Suggested-fix validation**
    As a developer, I want auto-fix suggestions verified before they're posted, so that one-click commits don't break the build.
    - Acceptance: only generate `suggestion` blocks for high-confidence findings; optionally apply-and-typecheck/lint the fix in a sandbox before including it.

40. **Data-privacy positioning**
    As a privacy-conscious user, I want it documented that my code only ever goes to my own provider, so that I trust the tool over hosted SaaS.
    - Acceptance: doc + landing point — BYOK means we never see/store code or keys; inference goes directly from the user's runner to the user's chosen provider (paired with secret redaction, #15).

41. **Repo hygiene & demo**
    As a prospective contributor/user, I want a polished OSS repo, so that the project is credible and easy to adopt.
    - Acceptance: `CONTRIBUTING.md`, `SECURITY.md`, an example/demo repo, a demo GIF/screenshots, and a documented telemetry-opt-in (default off) policy.

42. **npm + Homebrew distribution (CD / release pipeline)**
    As a user, I want to install via npm or `brew`, so that adoption matches the rest of Prowl QA.
    - Acceptance: tag-triggered publish workflow (`.github/workflows/publish.yml`) mirroring `prowl`'s — on `v*` tags: `npm ci` → build → lint → test → `npm publish --provenance --access public`, then extract the `CHANGELOG` section and create a GitHub Release.
    - Acceptance: published `prowl-review` npm package (confirm the name is free on npm first; `prowl` itself had to ship as `prowl-tools`); `Formula/prowl-review.rb` added to `homebrew-tap` (pulls npm tarball, Apache-2.0, node@20).

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
    - Acceptance: register the GitHub App with the **raccoon avatar + display name** so reviews post under a branded `prowl-review[bot]` identity (CodeRabbit/Codex-style branding) instead of `github-actions[bot]` — a GitHub Action can't customize the bot avatar, so this branding only lands via the App.

48. **Watch & adopt delegated-API OAuth if a provider ships it**
    As a maintainer, I want to track providers' delegated-API OAuth and adopt it when available, so that users eventually get one-click, TOS-compliant, subscription-aware auth.
    - Acceptance: tracking note records that no provider offers delegated-API OAuth as of 2026-06 (OpenAI "Sign in with ChatGPT" = identity only).
    - Acceptance: when a real authorization-code flow yielding delegated API access (billed to the user's own account) ships, add it as a first-class auth option behind the provider abstraction.

49. **Debug/verbose mode**
    As a maintainer tuning the reviewer, I want to inspect what a run actually did, so that I can diagnose odd reviews.
    - Acceptance: a verbose flag emits the assembled prompts, fetched-context list, raw findings (pre/post judge + verification), and token/cost breakdown — without leaking secrets (respects #15).
    - Acceptance: structured **JSONL** run log (streamable, line-per-event) so a partial run is still readable if the process exits early.

---

Completed items live in [`docs/resolved.md`](./resolved.md).
