# Backlog

Prioritized list of planned features, improvements, and technical debt for **`prowl-review`** — a BYOK (bring-your-own-key) AI code-review tool for the Prowl QA suite. Delivered first as a GitHub Action + local CLI in TypeScript, reusing `prowl`'s toolchain and the provider abstraction from `prowl/src/generator/ai.ts`. Multi-provider (Claude default / OpenAI / Gemini). Apache-2.0.

**Positioning (why we're building, not just tuning Claude Code's review):** a single-pass, diff-only LLM review (what Claude Code and Codex do today) misses the bugs that live in the seam between changed code and its callers, and it *reads* like a wall of text. The paid tools (CodeRabbit, Greptile, Qodo) win on four techniques + presentation, all replicable BYOK: (1) **cross-file context** via **agentic retrieval** (grep/read on demand — NOT a vector DB), (2) **multi-pass specialized review + a judge/dedup pass**, (3) **linter/SAST grounding**, (4) **false-positive verification**; plus a **structured walkthrough + committable inline suggestions**. Cost is managed via **prompt caching** + **risk-tiered** agent counts, so per-review stays in cents — still far under CodeRabbit's ~$576/yr for this user.

User stories use **As a `<role>`, I want `<capability>`, so that `<value>`.** Each carries acceptance criteria.

When an item is completed, move it to [`docs/resolved.md`](./resolved.md) with `(completed: YYYY-MM-DD)` and remove it here; keep the remaining items' numbers stable (don't renumber) so references stay valid.

## High Priority

60. **Cut and publish v0.2.0 (npm + Homebrew + Action tag)**
    As a prowl-review user installing from npm/Homebrew or pinning the Action, I want the accumulated post-0.1.0 work released, so that branded reviews, the live "Prowl Review" check run, and the dependency/toolchain upgrades reach real installs instead of living only in this repo's dogfood.
    - Context: `## [Unreleased]` has 10 top-level entries since `0.1.0` (2026-07-13), including a **breaking** Node floor change (`>=22.13.0 <23 || >=24`) — still fine as `0.2.0` under 0.x semver, but call it out prominently in the release notes.
    - Acceptance: follow the maintained release checklist in `docs/releasing.md` (version bump, changelog section cut, tag-triggered `publish.yml`, GitHub Release); before tagging, align `.nvmrc`, CI/publish workflows, examples, Homebrew packaging, and README/docs runtime/toolchain references with the declared Node floor (`>=22.13.0 <23 || >=24`) so contributors and automation no longer default to unsupported Node 20; make npm Trusted Publishing the default publish path; bump `Formula/prowl-review.rb` in `prowl-tools/homebrew-tap` (tap `prowl-tools/tap`, new tarball `url` + `sha256`); move/advance the Action's floating `v1` tag (or document the versioning policy if we choose immutable tags only); README/docs version references current; release workflows verified under the supported Node toolchain.
    - Operational note: treat re-issuing `NPM_TOKEN` as a temporary fallback only if Trusted Publishing cannot land before v0.2.0; if token publishing remains supported, document the token owner, npm scope, expiry, and rotation validation in `docs/releasing.md`.

## Medium Priority

41. **Repo hygiene & demo** *(core docs done — see resolved.md)*
    As a prospective contributor/user, I want a polished OSS repo, so that the project is credible and easy to adopt.
    - **Done:** `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue/PR templates, an `examples/` quickstart (workflows + starter config), a documented no-telemetry policy (opt-in if ever added), and `docs/example-review.md` (a rendered sample walkthrough standing in for screenshots).
    - **Done (contributor ergonomics & discoverability):** README status/license/CI/Node/PRs/docs badges, `.editorconfig`, `.nvmrc` (Node 22.13.0 pin), and `.github/dependabot.yml` (weekly npm + github-actions updates, grouped dev bumps). Added the **npm version badge** now that `0.1.0` is published (#42).
    - Acceptance (remaining): a **demo GIF / screen capture** of a live review (binary asset), and a standalone **example/demo repo** (separate repository) that shows prowl-review running end-to-end.

61. **Single branded checks row — hide the Actions workflow row (`workflow_run` chaining)**
    As a maintainer viewing a PR, I want prowl-review to appear exactly once in the checks list — the branded **Prowl Review** row — so that the presentation matches hosted reviewers (CodeRabbit shows one row; we currently show the branded row *plus* an octocat `prowl-review / review` Actions row).
    - Mechanism: workflows triggered by `workflow_run` (chained off the `CI` workflow in `.github/workflows/ci.yml`) don't attach a row to the PR checks list — the same reason the `@prowl-review` command workflow is already invisible. Rewire the auto-review workflow (and the reusable template) to trigger off `CI` completing instead of `pull_request`.
    - Known tradeoffs to design around: review starts only after CI completes (~1 min latency); PR number/head/base must be derived from the `workflow_run` payload, while `CI` itself must subscribe to the needed PR transitions (`opened`, `synchronize`, `ready_for_review`, `reopened`) because `workflow_run` does not preserve the original PR action; the trusted-base config/guidelines checkout security wiring must be preserved; the branded check run becomes the **only** failure surface, so its error/superseded close-outs (#107) are load-bearing.
    - Acceptance: on a test PR, the only prowl-review presence in the checks list is the branded "Prowl Review" check run (live yellow → green/red); `.github/workflows/ci.yml` explicitly covers `opened`, `synchronize`, `ready_for_review`, and `reopened`, and the downstream `workflow_run` review path is event-agnostic except for PR/ref lookup from the completed `CI` run; reviews start only for `workflow_run.conclusion == success` after existing fork/draft/trust gates pass; any future non-success override must use a separate repo-controlled approval/permission signal, not a `workflow_run` conclusion; failure, cancelled, timed_out, skipped, action_required, neutral, and unsupported conclusions do not start reviews; command mode unaffected; `examples/reusable/` templates + `prowl-code-review-docs` updated; drift tests adjusted.

62. **Hosted GitHub App design doc (revival gate for parked #47)**
    As the product owner, I want the three open Phase-2 decisions resolved on paper before any code, so that #47 (install-once hosted App) can be revived with a clear, mission-consistent build plan.
    - The three decisions: (1) **key custody** — hosted BYOK means holding user provider keys (encrypted at rest) vs. the mission's self-sovereignty stance; evaluate shipping the App service **open-source with a one-click self-host path** (hosted for convenience, self-hostable for sovereignty, same TS core); (2) **retrieval strategy** — GitHub API-based agentic retrieval vs. ephemeral sandboxed clones (linter/SAST grounding needs a real filesystem); (3) **free/paid boundary** — Action/CLI/self-host stay free forever; decide whether the managed tier is free, capped, or the eventual monetization.
    - Also cover: webhook receiver architecture (e.g. Cloudflare Workers + Queues for near-zero marginal cost), abuse controls (per-PR budget cap), state/persistence (installations, keys, review state), key rotation/revocation/deletion, least-privilege access, tenant isolation between installations, and the migration path from the Action (same core, second delivery wrapper).
    - Acceptance: a `docs/design/hosted-app.md` with a decision log covering the above; for every listed decision — Phase-2 key custody, retrieval, and free/paid boundary; webhook architecture; abuse controls; state/persistence; secret lifecycle; least-privilege access; tenant isolation; and migration from the Action — the log records the selected option, rationale, rejected alternatives, and consequences; #47 stays parked until all required decisions meet that bar and the doc is reviewed/approved — this item is the doc, not the build.

---

Completed items live in [`docs/resolved.md`](./resolved.md). Consciously
deferred / blocked items (#45 Codex subscription, #46 GitLab/Bitbucket, #47 hosted
App, #48 delegated-API OAuth) are parked there with dates — see the "Deferred /
parked" section.
