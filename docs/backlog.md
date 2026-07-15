# Backlog

Prioritized list of planned features, improvements, and technical debt for **`prowl-review`** — a BYOK (bring-your-own-key) AI code-review tool for the Prowl QA suite. Delivered first as a GitHub Action + local CLI in TypeScript, reusing `prowl`'s toolchain and the provider abstraction from `prowl/src/generator/ai.ts`. Multi-provider (Claude default / OpenAI / Gemini). Apache-2.0.

**Positioning (why we're building, not just tuning Claude Code's review):** a single-pass, diff-only LLM review (what Claude Code and Codex do today) misses the bugs that live in the seam between changed code and its callers, and it *reads* like a wall of text. The paid tools (CodeRabbit, Greptile, Qodo) win on four techniques + presentation, all replicable BYOK: (1) **cross-file context** via **agentic retrieval** (grep/read on demand — NOT a vector DB), (2) **multi-pass specialized review + a judge/dedup pass**, (3) **linter/SAST grounding**, (4) **false-positive verification**; plus a **structured walkthrough + committable inline suggestions**. Cost is managed via **prompt caching** + **risk-tiered** agent counts, so per-review stays in cents — still far under CodeRabbit's ~$576/yr for this user.

User stories use **As a `<role>`, I want `<capability>`, so that `<value>`.** Each carries acceptance criteria.

When an item is completed, move it to [`docs/resolved.md`](./resolved.md) with `(completed: YYYY-MM-DD)` and remove it here; keep the remaining items' numbers stable (don't renumber) so references stay valid.

## High Priority

_No open high-priority items._

## Medium Priority

41. **Repo hygiene & demo** *(core docs done — see resolved.md)*
    As a prospective contributor/user, I want a polished OSS repo, so that the project is credible and easy to adopt.
    - **Done:** `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue/PR templates, an `examples/` quickstart (workflows + starter config), a documented no-telemetry policy (opt-in if ever added), and `docs/example-review.md` (a rendered sample walkthrough standing in for screenshots).
    - **Done (contributor ergonomics & discoverability):** README status/license/CI/Node/PRs/docs badges, `.editorconfig`, `.nvmrc` (Node 20 pin), and `.github/dependabot.yml` (weekly npm + github-actions updates, grouped dev bumps). Added the **npm version badge** now that `0.1.0` is published (#42).
    - Acceptance (remaining): a **demo GIF / screen capture** of a live review (binary asset), and a standalone **example/demo repo** (separate repository) that shows prowl-review running end-to-end.

42. **npm + Homebrew distribution (CD / release pipeline)** *(pipeline + tooling staged)*
    As a user, I want to install via npm or `brew`, so that adoption matches the rest of Prowl QA.
    - **Done:** tag-triggered `.github/workflows/publish.yml` (on `vX.Y.Z`: tag↔version guard → `npm ci` → build → lint → test → release-note verification → draft GitHub Release → `npm publish --provenance --access public` → publish GitHub Release); package made publish-ready (`publishConfig.access: public`); Homebrew formula template (`packaging/homebrew/prowl-review.rb`) + `docs/releasing.md`.
    - **Done (first release shipped 2026-07-14):** `prowl-review@0.1.0` published to npm **with provenance** (required making the repo public — npm rejects provenance for private sources), GitHub Release `v0.1.0` published, and `Formula/prowl-review.rb` (real `url` + `sha256`, `brew style`/`audit --online` clean) added to `Prowl-qa/homebrew-tap` (branch `add-prowl-review-formula`, pending merge).
    - Acceptance (remaining, operational): merge the `homebrew-tap` formula branch; the `NPM_TOKEN` automation token **expires 2026-10-12** — re-issue before then (or migrate to npm Trusted Publishing to drop the token entirely).

43. **Docs + marketing integration (dedicated site)**
    As a prospective user, I want docs and a landing section, so that I can discover and set up the tool.
    - **Decision (2026-06-30):** prowl-review gets its own **dedicated satellite site** (e.g. `review.prowl.tools`), mirroring the suite pattern — `prowl-web` already lists "Prowl Code Review" as a *coming soon* tile, and Hub/Infra each live at their own subdomain. Build a new `prowl-review-docs` Docusaurus site reusing `prowl-docs`' theme/brand (teal, raccoon, Space Grotesk), then flip the `prowl-web` Suite tile from `href: null` to the live link.
    - Acceptance: dedicated Docusaurus site (own repo) with getting-started + the differentiators + config/commands reference; **port the ready-made auth + privacy content** from [`docs/auth.md`](./auth.md) and [`docs/privacy.md`](./privacy.md) (#38/#40, done) as site pages; raccoon/brand conventions; "made for agents, controlled by humans" framing.
    - **Done:** dedicated Docusaurus site built in `prowl-code-review-docs` (getting-started, config, cli, bot-commands, ensemble, grounding, cross-file-context, repo-wide-learnings, auth, privacy, example-review), configured for `review.prowl.tools`, builds clean. README "Documentation" cross-link added. `prowl-web` wiring staged: `fix-code-review-docs-link` points the live `/code-review` CTA at `docs.prowl.tools` (kills the dead link now), and `stage-review-docs-flip` flips the page CTA + homepage tile / footer / docs-hub entry to `review.prowl.tools` — **merge that only after the site is deployed.**
    - **Done:** docs site **deployed and live at `review.prowl.tools`** (Vercel, Cloudflare CNAME, Let's Encrypt cert, HTTP 200). README "Documentation" section now points at the live site (`flip-docs-link-live`).
    - Acceptance (remaining, operational): merge `prowl-web`'s `stage-review-docs-flip` so the homepage tile / footer / docs-hub entry + `/code-review` CTA point at the now-live `review.prowl.tools` (its base `fix-code-review-docs-link` is folded in). That's the last click to fully close #43.

59. **Branded bot identity via a GitHub App token (Action path)**
    As a user, I want prowl-review's PR comments to post under a branded `prowl-review[bot]` identity with our raccoon avatar (like CodeRabbit/Greptile), so that reviews look first-class and clearly attributable — without waiting on the hosted App (#47).
    - **Done (buildable parts):** a branded example workflow (`examples/workflows/prowl-review-branded.yml`) that mints an installation token with `actions/create-github-app-token` and passes it to the Action via `github-token` (+ `bot-login` derived from the app slug); optional App-token support in the reusable org templates (`examples/reusable/*`), gated on `PROWL_APP_ID` / `PROWL_APP_PRIVATE_KEY` secrets and falling back to the default token when absent; README + docs "Branded bot identity" section. The Action already accepts `github-token` / `bot-login`, so no core code change is needed.
    - **Done (dogfood wiring):** this repo's own workflows (`.github/workflows/prowl-review.yml` + `prowl-review-command.yml`) now mint the App token when `PROWL_APP_ID` is set and post as `<app-slug>[bot]`, falling back to `github-actions[bot]` when the secrets are absent — **safe to run before the App exists**. Drift tests assert the branded wiring on both dogfood workflows.
    - Acceptance (remaining, operational): **register the GitHub App** under the `prowl-tools` org ("Prowl Review" name → `prowl-review[bot]` + raccoon avatar), grant it `pull-requests` / `issues` / `checks` write (+ `contents` read, metadata read), install it on the target repos, and add the `PROWL_APP_ID` + `PROWL_APP_PRIVATE_KEY` secrets. Once the secrets land, the dogfood workflows post branded automatically. **Asset needed:** a square raccoon avatar PNG for the App. One-time transition note: the first branded run won't find the prior `github-actions[bot]` summary, so it posts a fresh one (update-not-duplicate re-anchors on the new login thereafter).
    - Note: distinct from #47 (the *hosted* install-once App). This is the Phase-1 branding path on the existing Action; #47 remains the managed-service phase and would post under the same App identity.

---

Completed items live in [`docs/resolved.md`](./resolved.md). Consciously
deferred / blocked items (#45 Codex subscription, #46 GitLab/Bitbucket, #47 hosted
App, #48 delegated-API OAuth) are parked there with dates — see the "Deferred /
parked" section.
