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

37. **Reusable org-level workflow**
    As an org owner, I want one reusable workflow referenced by all repos, so that "across all my projects" needs no YAML copy-paste.
    - Acceptance: documented `workflow_call` workflow (intended for `Prowl-qa/.github`) that any repo invokes in a few lines.

38. **Document the auth policy (BYOK default; Codex the only subscription exception)**
    As a user, I want clear docs on how `prowl-review` authenticates to each provider, so that I understand the cost model and avoid TOS/account-ban risk.
    - Acceptance: README + `prowl-docs` state the policy — **BYO API key for every configurable provider** (Claude, OpenAI, Gemini); we never store/proxy keys.
    - Acceptance: state that **subscription routing is supported for OpenAI/Codex only** (opt-in; see the Codex-subscription backend item) and **not** for Claude or Gemini — directly reusing their subscription OAuth in a third-party tool is prohibited and gets accounts banned (Anthropic Consumer Terms §3.7; Google Feb-2026 bans; OpenClaw is the precedent). Explain *why*.

40. **Data-privacy positioning**
    As a privacy-conscious user, I want it documented that my code only ever goes to my own provider, so that I trust the tool over hosted SaaS.
    - Acceptance: doc + landing point — BYOK means we never see/store code or keys; inference goes directly from the user's runner to the user's chosen provider (paired with secret redaction, #15).

41. **Repo hygiene & demo** *(core docs done — see resolved.md)*
    As a prospective contributor/user, I want a polished OSS repo, so that the project is credible and easy to adopt.
    - **Done:** `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue/PR templates, an `examples/` quickstart (workflows + starter config), a documented no-telemetry policy (opt-in if ever added), and `docs/example-review.md` (a rendered sample walkthrough standing in for screenshots).
    - Acceptance (remaining): a **demo GIF / screen capture** of a live review (binary asset), and a standalone **example/demo repo** (separate repository) that shows prowl-review running end-to-end.

42. **npm + Homebrew distribution (CD / release pipeline)** *(pipeline + tooling staged)*
    As a user, I want to install via npm or `brew`, so that adoption matches the rest of Prowl QA.
    - **Done:** tag-triggered `.github/workflows/publish.yml` (on `vX.Y.Z`: tag↔version guard → `npm ci` → build → lint → test → release-note verification → draft GitHub Release → `npm publish --provenance --access public` → publish GitHub Release); package made publish-ready (`publishConfig.access: public`); Homebrew formula template (`packaging/homebrew/prowl-review.rb`) + `docs/releasing.md`.
    - Acceptance (remaining, operational): add the `NPM_TOKEN` repo secret and cut the **first release** (push a `vX.Y.Z` tag) to actually publish; add the filled-in `Formula/prowl-review.rb` (real `url` + `sha256`) to the separate `Prowl-qa/homebrew-tap` repo.

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
