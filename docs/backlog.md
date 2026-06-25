# Backlog

Prioritized list of planned features, improvements, and technical debt for **`prowl-review`** — a BYOK (bring-your-own-key) AI code-review tool for the Prowl QA suite. Delivered first as a GitHub Action + local CLI in TypeScript, reusing `prowl`'s toolchain and the provider abstraction from `prowl/src/generator/ai.ts`. Multi-provider (Claude default / OpenAI / Gemini). Apache-2.0.

**Positioning (why we're building, not just tuning Claude Code's review):** a single-pass, diff-only LLM review (what Claude Code and Codex do today) misses the bugs that live in the seam between changed code and its callers, and it *reads* like a wall of text. The paid tools (CodeRabbit, Greptile, Qodo) win on four techniques + presentation, all replicable BYOK: (1) **cross-file context** via **agentic retrieval** (grep/read on demand — NOT a vector DB), (2) **multi-pass specialized review + a judge/dedup pass**, (3) **linter/SAST grounding**, (4) **false-positive verification**; plus a **structured walkthrough + committable inline suggestions**. Cost is managed via **prompt caching** + **risk-tiered** agent counts, so per-review stays in cents — still far under CodeRabbit's ~$576/yr for this user.

User stories use **As a `<role>`, I want `<capability>`, so that `<value>`.** Each carries acceptance criteria.

When an item is completed, move it to [`docs/resolved.md`](./resolved.md) with `(completed: YYYY-MM-DD)` and remove it here; keep the remaining items' numbers stable (don't renumber) so references stay valid.

## High Priority

5. **Multi-language support**
   As a developer on any stack, I want context retrieval and linting to work beyond JS/TS, so that `prowl-review` is a real CodeRabbit replacement (and covers the Prowl suite's Python/YAML too).
   - **Done (core, see resolved.md):** a language-detection primitive (`src/review/language.ts`) makes the review language-aware (specialist prompts state the PR's languages); grounding selects linters via the detector (per-language seam for #16b); unsupported languages degrade gracefully (LLM-reviewed). Cross-file context retrieval was already language-agnostic (grep/read).
   - Acceptance (remaining): language-agnostic **tree-sitter** parsing feeding AST-assisted caller/definition lookup for #4 — sharper symbol resolution than grep, weighed against the heavy WASM-grammar dependency vs. the "agentic grep, no heavy infra" principle (#4).

## Medium Priority

16b. **More grounding runners: Semgrep** *(framework + ESLint + Ruff + Gitleaks done — see resolved.md)*
    As a reviewer, I want SAST fed into the review too, so that grounding isn't lint-only.
    - **Done:** Ruff (Python) and Gitleaks (secrets) added to the `src/grounding` registry, normalized to the findings schema, per-language-selected via #5's detector, running ungated (own rulesets, no repo code); graceful degradation when a tool is absent.
    - Acceptance (remaining): add **Semgrep** (SAST, rule-configurable) as a runner — needs a ruleset-sourcing decision (network registry `--config auto`/`p/…` vs. repo `.semgrep.yml` vs. a bundled set) consistent with the no-extra-infra principle.

22. **Update-not-duplicate: resolve fixed threads + respect human replies** *(core + thread tidy-up done — see resolved.md)*
    As a developer, I want re-runs to also tidy up stale threads and honor my replies, so that the PR stays clean and the bot isn't argumentative.
    - **Done (core):** the summary is found by marker and updated in place (now a top-level PR comment, not a stacked review); only net-new inline findings are posted (deduped via the #12 state fingerprints).
    - **Done:** fixed finding threads are resolved via GraphQL `resolveReviewThread` when the finding no longer appears in the latest full review.
    - **Done:** human replies are honored — "won't fix"/"acknowledged" resolves the thread and withholds the finding; "I disagree" keeps the thread open and withholds the finding (withdrawn from re-emit) instead of blindly re-posting it.
    - Acceptance (remaining): on "I disagree", have the judge actively **re-justify** the finding (defend with reasoning) or formally **withdraw** it, rather than just withholding it — rides with the bot-command/event infra (#26/#27) that owns reply-driven re-review.

26. **Bot command set** *(core verbs done — see resolved.md)*
    As a developer, I want chat commands to control the reviewer, so that I can drive it from the PR like CodeRabbit.
    - **Done:** `@prowl-review` command parsing + verb allowlist (#14), trust-gated to owner/member/collaborator, dispatched from an `issue_comment` workflow + a `command` CLI subcommand (Action `mode: command`). Verbs: `review` (re-review latest), `full review` (full re-scan), `pause`/`resume` (auto-review toggle persisted in the summary state marker), `help`.
    - **Done:** `ignore` verb (see resolved.md, #30) — replying `@prowl-review ignore` on a finding mutes it for the PR (fingerprint recovered from the thread → per-PR ignore list in the #12 state marker).
    - Acceptance (remaining): `resolve` verb — mark a finding's thread resolved from a reply; needs comment→thread (GraphQL node) mapping and overlaps #22's auto-resolution.
    - Acceptance (remaining): `configure` verb — adjust review settings from a comment (scope/semantics TBD; likely a thin wrapper over `.prowl-review.yml` keys).

30. **Explicit guidelines + learnings files (the OSS replacement for CodeRabbit "learnings")**
    As a team, I want version-controlled review guidelines and a learned-patterns file, so that the reviewer is tuned to us and stops repeating known false positives.
    - **Done (core, see resolved.md):** the reviewer loads `CLAUDE.md`/`REVIEW_GUIDELINES.md` **and** a `LEARNED_PATTERNS.md` and injects them into the prompt (learned patterns as a distinct "do not re-raise" section); an optional org-wide guidelines **file** (`org-guidelines-path` / `PROWL_ORG_GUIDELINES_PATH`) is injected into every repo's prompts alongside per-repo files.
    - **Done:** the `@prowl-review ignore` feedback path (see resolved.md) — muting a finding persists its fingerprint to the #12 state marker and future reviews suppress it (per-PR). The 👎-reaction trigger is impractical via Actions (no usable reaction event).
    - Acceptance (remaining): **repo-wide** learnings — persist muted patterns across PRs (write back to `LEARNED_PATTERNS.md` or a repo-level store), so an ignore on one PR teaches future PRs. Needs a commit/persistent-store decision (today the mute is per-PR via #12).
    - Acceptance (remaining): support the org-wide guidelines template via **URL** (not just a file), so orgs can host one shared standard.

33. **Finishing touches: PR description / docstring / test generation** *(PR-description generation done — see resolved.md)*
    As a developer, I want the reviewer to draft the PR description and offer docstrings/unit tests, so that I get CodeRabbit-style assists.
    - **Done:** auto-generate/update a PR description from the diff (opt-in `prDescription.enabled`) — fills an empty PR body with a marked, self-refreshing summary block; never overwrites a human-authored description.
    - Acceptance (remaining): commands to generate **docstrings** and **unit-test stubs** for changed code (likely `@prowl-review` verbs producing committable suggestions).

34. **Dependency-CVE / license scanning**
    As a security-conscious developer, I want changed dependencies checked for known CVEs and license issues, so that risky deps are flagged in review.
    - Acceptance: detect dependency-manifest changes; surface known-vuln advisories and license-policy violations as findings.

37. **Reusable org-level workflow**
    As an org owner, I want one reusable workflow referenced by all repos, so that "across all my projects" needs no YAML copy-paste.
    - Acceptance: documented `workflow_call` workflow (intended for `Prowl-qa/.github`) that any repo invokes in a few lines.

38. **Document the auth policy (BYOK default; Codex the only subscription exception)**
    As a user, I want clear docs on how `prowl-review` authenticates to each provider, so that I understand the cost model and avoid TOS/account-ban risk.
    - Acceptance: README + `prowl-docs` state the policy — **BYO API key for every configurable provider** (Claude, OpenAI, Gemini); we never store/proxy keys.
    - Acceptance: state that **subscription routing is supported for OpenAI/Codex only** (opt-in; see the Codex-subscription backend item) and **not** for Claude or Gemini — directly reusing their subscription OAuth in a third-party tool is prohibited and gets accounts banned (Anthropic Consumer Terms §3.7; Google Feb-2026 bans; OpenClaw is the precedent). Explain *why*.

39. **Suggested-fix validation**
    As a developer, I want auto-fix suggestions verified before they're posted, so that one-click commits don't break the build.
    - Acceptance: only generate `suggestion` blocks for high-confidence findings; optionally apply-and-typecheck/lint the fix in a sandbox before including it.

40. **Data-privacy positioning**
    As a privacy-conscious user, I want it documented that my code only ever goes to my own provider, so that I trust the tool over hosted SaaS.
    - Acceptance: doc + landing point — BYOK means we never see/store code or keys; inference goes directly from the user's runner to the user's chosen provider (paired with secret redaction, #15).

41. **Repo hygiene & demo** *(core docs done — see resolved.md)*
    As a prospective contributor/user, I want a polished OSS repo, so that the project is credible and easy to adopt.
    - **Done:** `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue/PR templates, an `examples/` quickstart (workflows + starter config), a documented no-telemetry policy (opt-in if ever added), and `docs/example-review.md` (a rendered sample walkthrough standing in for screenshots).
    - Acceptance (remaining): a **demo GIF / screen capture** of a live review (binary asset), and a standalone **example/demo repo** (separate repository) that shows prowl-review running end-to-end.

42. **npm + Homebrew distribution (CD / release pipeline)**
    As a user, I want to install via npm or `brew`, so that adoption matches the rest of Prowl QA.
    - Acceptance: tag-triggered publish workflow (`.github/workflows/publish.yml`) mirroring `prowl`'s — on `v*` tags: `npm ci` → build → lint → test → `npm publish --provenance --access public`, then extract the `CHANGELOG` section and create a GitHub Release.
    - Acceptance: published `prowl-review` npm package (confirm the name is free on npm first; `prowl` itself had to ship as `prowl-tools`); `Formula/prowl-review.rb` added to `homebrew-tap` (pulls npm tarball, Apache-2.0, node@20).

43. **Docs + marketing integration**
    As a prospective user, I want docs and a landing section, so that I can discover and set up the tool.
    - Acceptance: `docs/code-review.md` + sidebar entry in `prowl-docs`; a code-review section + install snippet in `prowl-web`; raccoon/brand conventions; "made for agents, controlled by humans" framing.

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

---

Completed items live in [`docs/resolved.md`](./resolved.md).
