# Backlog

Prioritized list of planned features, improvements, and technical debt for **`prowl-review`** — a BYOK (bring-your-own-key) AI code-review tool for the Prowl QA suite. Delivered first as a GitHub Action + local CLI in TypeScript, reusing `prowl`'s toolchain and the provider abstraction from `prowl/src/generator/ai.ts`. Multi-provider (Claude default / OpenAI / Gemini). Apache-2.0.

**Positioning (why we're building, not just tuning Claude Code's review):** a single-pass, diff-only LLM review (what Claude Code and Codex do today) misses the bugs that live in the seam between changed code and its callers, and it *reads* like a wall of text. The paid tools (CodeRabbit, Greptile, Qodo) win on four techniques + presentation, all replicable BYOK: (1) **cross-file context** via **agentic retrieval** (grep/read on demand — NOT a vector DB), (2) **multi-pass specialized review + a judge/dedup pass**, (3) **linter/SAST grounding**, (4) **false-positive verification**; plus a **structured walkthrough + committable inline suggestions**. Cost is managed via **prompt caching** + **risk-tiered** agent counts, so per-review stays in cents — still far under CodeRabbit's ~$576/yr for this user.

User stories use **As a `<role>`, I want `<capability>`, so that `<value>`.** Each carries acceptance criteria.

When an item is completed, move it to [`docs/resolved.md`](./resolved.md) with `(completed: YYYY-MM-DD)` and remove it here; keep the remaining items' numbers stable (don't renumber) so references stay valid.

## High Priority

_No open high-priority items._

## Medium Priority

63. **Migrate npm publishing to Trusted Publishing (OIDC)**
    _Status: implemented on `trusted-publishing` — pending the one-time npmjs.com trusted-publisher config and a live OIDC release. In-repo work done: `publish.yml` drops `NODE_AUTH_TOKEN` + every `secrets.NPM_TOKEN` reference, keeps `id-token: write` and `npm publish --provenance --access public`, and moves the toolchain to Node 22.14.0 + npm 11.5.1 (npm 11.5.0 introduced OIDC publishing support; npm 11.5.1 is the minimum compatible version); a workflow-only bump, so `engines`/`.nvmrc`/CI are untouched. `docs/releasing.md` now documents Trusted Publishing as the publish path (npmjs.com config as the one-time prerequisite) and demotes `NPM_TOKEN` to a retire-after-first-OIDC-release note; changelog entry added. **Remaining (manual, out of repo):** the user configures the `prowl-review` package's GitHub Actions trusted publisher on npmjs.com (this repo + `publish.yml` with allowed action `npm publish`), then verifies the next tag-triggered release publishes through OIDC, then deletes the npm token + `NPM_TOKEN` repository secret. Keep here until that live OIDC release is confirmed, then move to `docs/resolved.md`._
    As the release maintainer, I want `publish.yml` to authenticate via npm Trusted Publishing instead of a stored `NPM_TOKEN`, so that releases stop depending on a manually rotated secret. Deferred out of the v0.2.0 release (#60), which published on the token per its fallback clause.
    - Deadline pressure: the current `NPM_TOKEN` **expires 2026-10-12** — land this before then. If a temporary token fallback is unavoidable, rotate only to an npm granular access token scoped to `prowl-review` publishing, with the shortest practical expiry; do not document or recreate legacy/classic automation tokens.
    - Acceptance: first upgrade `.github/workflows/publish.yml` to a Trusted Publishing-compatible toolchain (Node >=22.14.0 with npm >=11.5.1; prefer the current stable Node line used by npm's GitHub Actions example) before removing token auth; configure the `prowl-review` package for Trusted Publishing on npmjs.com (GitHub Actions publisher: this repo + `publish.yml`); drop `NODE_AUTH_TOKEN` and every `secrets.NPM_TOKEN` reference from `.github/workflows/publish.yml` (keep OIDC `id-token: write`, already present for provenance); verify with the next tag-triggered release; update `docs/releasing.md` prerequisites; then delete the npm token and the repository secret.

41. **Repo hygiene & demo** *(core docs done — see resolved.md)*
    As a prospective contributor/user, I want a polished OSS repo, so that the project is credible and easy to adopt.
    - **Done:** `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue/PR templates, an `examples/` quickstart (workflows + starter config), a documented no-telemetry policy (opt-in if ever added), and `docs/example-review.md` (a rendered sample walkthrough standing in for screenshots).
    - **Done (contributor ergonomics & discoverability):** README status/license/CI/Node/PRs/docs badges, `.editorconfig`, `.nvmrc` (Node 22.13.0 pin), and `.github/dependabot.yml` (weekly npm + github-actions updates, grouped dev bumps). Added the **npm version badge** now that `0.1.0` is published (#42).
    - Acceptance (remaining): a **demo GIF / screen capture** of a live review (binary asset), and a standalone **example/demo repo** (separate repository) that shows prowl-review running end-to-end.

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
