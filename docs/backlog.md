# Backlog

Prioritized list of planned features, improvements, and technical debt for **`prowl-review`** — a BYOK (bring-your-own-key) AI code-review tool for the Prowl QA suite. Delivered first as a GitHub Action + local CLI in TypeScript, reusing `prowl`'s toolchain and the provider abstraction from `prowl/src/generator/ai.ts`. Multi-provider (Claude default / OpenAI / Gemini). Apache-2.0.

**Positioning (why we're building, not just tuning Claude Code's review):** a single-pass, diff-only LLM review (what Claude Code and Codex do today) misses the bugs that live in the seam between changed code and its callers, and it *reads* like a wall of text. The paid tools (CodeRabbit, Greptile, Qodo) win on four techniques + presentation, all replicable BYOK: (1) **cross-file context** via **agentic retrieval** (grep/read on demand — NOT a vector DB), (2) **multi-pass specialized review + a judge/dedup pass**, (3) **linter/SAST grounding**, (4) **false-positive verification**; plus a **structured walkthrough + committable inline suggestions**. Cost is managed via **prompt caching** + **risk-tiered** agent counts, so per-review stays in cents — still far under CodeRabbit's ~$576/yr for this user.

User stories use **As a `<role>`, I want `<capability>`, so that `<value>`.** Each carries acceptance criteria.

When an item is completed, move it to [`docs/resolved.md`](./resolved.md) with `(completed: YYYY-MM-DD)` and remove it here; keep the remaining items' numbers stable (don't renumber) so references stay valid.

## High Priority

64. **Self-hosted runner rollout — prowl-review on Lucius' Mac mini (subscription-backed reviews for all Prowl repos *and* the owner's personal `michaeltookes` repos)**
    _Status (2026-08-25): **runner + dogfood proven, rollout branches pushed.** Seven repo-level runners are online on Lucius' Mac mini (`lucius-mac-mini-<repo>`, labels `self-hosted,macOS,ARM64,prowl-review,codex`, one shared `CODEX_HOME=~/.codex-prowl-runner` behind the Codex lock; owner chose repo-level over org-level). The dogfood auto-review ran end-to-end on the runner (PR #92: `codex/gpt-5.5`, 52,887 in / 694 out / 20,608 cached tok, `$0.00`). `prowl-review-codex` branches are pushed and reviewed for `prowl`, `prowl-hub`, `prowl-infra-hub`, `prowl-web`, `prowl-docs`, `prowl-code-review-docs` (pinned to `prowl-tools/prowl-code-review@main` because the `v1` tag predates `provider: codex`). **Remaining:** (1) owner merges the six PRs and deletes `PROWL_AI_KEY_*` secrets from `prowl-web`; (2) decide whether the `claude-code-review.yml`/`claude.yml` workflows in `prowl`, `prowl-hub`, `prowl-infra-hub`, `prowl-docs` are retired (they still run on every PR incl. forks); (3) personal `michaeltookes` repos — owner to name them, then one repo-level runner + the two workflows each; (4) CodeRabbit uninstall per repo once green (owner); (5) repin the six repos' `uses:` to `@v1` after the next prowl-review release ships the codex provider; (6) branded `prowl-review[bot]` identity needs `PROWL_APP_ID`/`PROWL_APP_PRIVATE_KEY` on repos that lack them (currently only prowl-code-review/prowl-web)._
    As the owner, I want every repo I maintain — the `prowl-tools` org repos and the ones under my personal `michaeltookes` account — to get automatic + `@prowl-review` reviews from the always-on Mac mini I already use for runners, using the Codex subscription login that lives only on that machine, so that reviews are hands-off, zero-marginal-cost, and no subscription credential ever enters GitHub.
    - **Runner topology (two scopes, one machine):** (a) `prowl-tools` org — one **org-level** runner instance in a runner group restricted to the prowl-review workflows; (b) `michaeltookes` personal account — GitHub only allows **repository-level** runners for personal accounts (no org groups), so one runner instance **per personal repo** that opts in. All instances live on the Mac mini as separate runner services with a shared label set, e.g. `[self-hosted, macOS, prowl-review]`. Registration under each scope happens as that scope's account (`prowltools` for the org, `michaeltookes` for personal repos) — the workspace account policy governs only the Prowl repos.
    - **Codex auth on a multi-instance host:** a single runner instance runs one job at a time, so the org runner is naturally serialized; multiple instances are not. Because one `auth.json` must serve one serialized stream, choose one of: **(preferred)** one shared `CODEX_HOME` for the machine plus the **machine-wide Codex lock** from #45 so only one `codex` run executes at a time across all instances (one login to maintain); or one `CODEX_HOME` + separate `codex login` per runner instance (independent sessions, more logins to keep alive). **Never** copy `auth.json` between machines or instances (refresh tokens are single-use; a copied file logs out whichever side refreshes second). Pinned `codex` CLI version + `prowl-review` version on the host; a documented "re-login" runbook for when a session is revoked.
    - **Workflow changes (`.github/workflows/prowl-review.yml` + `prowl-review-command.yml`, then `examples/workflows/` + `examples/reusable/` templates):** `runs-on` the runner labels; a **job-level `if:`** same-repo gate so fork PRs are never scheduled onto the self-hosted runner (today's step-level gate is not enough — the job must not land there at all); a `concurrency` group per runner so Codex runs are serialized (one `auth.json` = one serialized stream, per OpenAI's guidance; specialist fan-out inside a single run is fine); `ai-provider: codex` and **no** `PROWL_AI_KEY_*` secrets on that job. Posting identity per scope: Prowl repos keep the branded `prowl-review[bot]` App token so the ChatGPT login never appears on GitHub (anonymity policy); personal repos use the default `github.token` (or a personal App) — no anonymity requirement there. The templates must be **repo-agnostic** (nothing `prowl-tools`-specific baked in) so a personal repo adopts them by copying one workflow file and pointing `uses:` at `prowl-tools/prowl-code-review@v1` / the reusable workflow.
    - **Accepted risk, recorded:** GitHub advises against self-hosted runners on public repos because any PR can run code on them. Mitigations: the job-level same-repo gate means only the owner's own accounts/agents can trigger a run; Codex runs `--sandbox read-only`; grounding linters (ESLint config is executable) run only on same-repo PRs; runner group limited to these workflows; runner user is unprivileged with no access to other secrets on the machine. Private personal repos carry none of the public-repo caveat (neither GitHub's runner warning nor OpenAI's "not for public or open-source repositories" line applies), so they can skip the fork gate. Revisit if any public repo on this path ever accepts outside contributors' PRs (then route those to the GitHub-hosted API-key ensemble instead).
    - **Rollout:** `prowl-code-review` first (dogfood, prove #45 + #65 end-to-end), then `prowl`, `prowl-hub`, `prowl-infra-hub`, `prowl-web`, `prowl-docs`, `prowl-code-review-docs`, then the `michaeltookes` repos the owner selects (one repo-level runner registration each; private ones first since they need no fork gate). Decide per repo whether the GitHub-hosted Claude+Gemini ensemble stays (as a public-safe fallback) or is retired to stop the API spend. CodeRabbit is removed from each repo once its prowl-review run is green.
    - Acceptance: a same-repo PR on each listed Prowl repo and on at least one public + one private `michaeltookes` repo gets a review posted from the Mac mini runner with no provider secret in that repo; two runner instances triggered at once never run `codex` concurrently against one `CODEX_HOME` (lock verified); a fork PR never schedules on a public repo's runner (verified with a throwaway fork); a runner restart/re-login runbook exists (secrets-bearing details in the private runbook, public docs hold the shape only); the example workflows/docs show the self-hosted + `codex` pattern with the public-repo caveat stated verbatim.

66. **Docs-site + marketing update for the Codex provider and self-hosted runners (cross-repo docs duty for #45/#64/#65)**
    As a prowl-review user reading review.prowl.tools, I want the docs to describe the keyless Codex provider and the self-hosted runner setup, so that the site stops contradicting the shipped product.
    - `prowl-code-review-docs` currently says the Codex backend is "not yet built / blocked until Legal/Compliance sign-off" (`docs/auth.md` TL;DR + "Why API keys only" section), lists only `anthropic|openai|gemini` in `docs/configuration.md` and `docs/github-action.md`, and has no self-hosted-runner guide. Rewrite `auth.md` to the #45 stance (first-party `codex` CLI, opt-in, self-hosted/local only, never `auth.json` in secrets, no Claude/Gemini equivalent), add `codex` + the `codex: { effort, lock, timeoutMs, lockTimeoutMs }` block to `configuration.md`, add `ai-provider: codex` + a self-hosted section to `github-action.md`, add a new "Self-hosted runner" guide (mirror `docs/self-hosted-runner.md` here, shape only), document the #65 usage-limit behavior (neutral check, retry note, zero-cost line), and cross-link `privacy.md`.
    - `prowl-web`: add Codex/ChatGPT-subscription to the provider list and a one-line "run it on your own runner for $0.00 marginal" mention.
    - Acceptance: docs site builds; every page that names providers lists `codex`; the stale "not yet built" text is gone; a self-hosted runner page exists in the Guides sidebar; `prowl-web` provider list updated.

## Medium Priority

41. **Repo hygiene & demo** *(core docs done — see resolved.md)*
    As a prospective contributor/user, I want a polished OSS repo, so that the project is credible and easy to adopt.
    - **Done:** `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue/PR templates, an `examples/` quickstart (workflows + starter config), a documented no-telemetry policy (opt-in if ever added), and `docs/example-review.md` (a rendered sample walkthrough standing in for screenshots).
    - **Done (contributor ergonomics & discoverability):** README status/license/CI/Node/PRs/docs badges, `.editorconfig`, `.nvmrc` (Node 22.13.0 pin), and `.github/dependabot.yml` (weekly npm + github-actions updates, grouped dev bumps). Added the **npm version badge** now that `0.1.0` is published (#42).
    - Acceptance (remaining): a **demo GIF / screen capture** of a live review (binary asset), and a standalone **example/demo repo** (separate repository) that shows prowl-review running end-to-end.

62. **Hosted GitHub App design doc (revival gate for parked #47)**
    _Status: doc drafted at [`docs/design/hosted-app.md`](./design/hosted-app.md) (branch `hosted-app-design-doc`) — pending maintainer review. The decision log now records selected options, rationale, rejected alternatives, and consequences for hosted architecture, key custody, retrieval, free/paid boundary, state/isolation/audit, migration identity, delivery ownership, and command authorization, with an explicit #62 coverage table tying each backlog decision to its record; #47 stays parked until the doc is approved, then this item moves to resolved._
    As the product owner, I want the Phase-2 hosted-App decisions resolved on paper before any code, so that #47 (install-once hosted App) can be revived with a clear, mission-consistent build plan.
    - The resolved decisions: (1) **key custody** — hosted BYOK uses an open-source, self-hostable service plus managed per-installation envelope encryption; (2) **retrieval strategy** — managed v1 uses bounded GitHub API retrieval, with sandboxed checkout parity later and Docker self-host parity immediately; (3) **free/paid boundary** — Action/CLI/App source/self-host stay free forever, while the managed tier launches free with published orchestration fairness limits that are not BYOK monetization caps.
    - Also covered: webhook receiver architecture (raw-header-preserving intake with Cloudflare Workers + Queues only as post-verification orchestration), abuse controls, state/persistence, key rotation/revocation/deletion, least-privilege access, tenant isolation, audit retention, migration identity, deterministic Action/App delivery ownership, command authorization, and the migration path from the Action (same core, second delivery wrapper).
    - Acceptance: a `docs/design/hosted-app.md` with a decision log covering the above; for every listed decision — Phase-2 key custody, retrieval, and free/paid boundary; webhook architecture; abuse controls; state/persistence; secret lifecycle; least-privilege access; tenant isolation; and migration from the Action — the log records the selected option, rationale, rejected alternatives, and consequences; #47 stays parked until all required decisions meet that bar and the doc is reviewed/approved — this item is the doc, not the build.

## Sunset Work Items

Decision (2026-08-26): **prowl-review moves to maintenance mode as an internal/personal tool.**
It works, it is dogfooded on every repo the owner maintains, and its backlog is essentially
complete — but PR review is the most crowded category in dev tools (model vendors bundle their
own reviewers; open-source BYOK has existed since 2023) and is not winnable as a solo product.
All build time goes to the Prowl CLI. The package stays published and the repo stays public;
the *product* framing (docs site, marketing placement) is retired. Items 41 (demo GIF / example
repo) and 62/#47 (hosted App) are **parked indefinitely** by this decision; #64 continues as
personal infrastructure, not product work.

67. **Record the maintenance-mode decision and set expectations in-repo**
    As the owner, I want the repo to say what it now is, so that neither I nor a passer-by treats it as a product with a roadmap.
    - README: replace the "code-review pillar of the Prowl QA suite" positioning and the "early development" status line with a short, honest status: maintained for the maintainer's own repos; issues welcome; no roadmap, no support promise; BYOK/Codex still the design. Remove the legacy "Prowl QA" brand strings (README, this backlog's header, `package.json` description).
    - Define "maintenance" concretely in `CONTRIBUTING.md`: dependency/security updates, breakages that affect the owner's repos, provider API changes. No new features unless the owner needs them personally.
    - Move items 41 and 62 to a "Parked" note (keep numbers) so the priority tiers read empty.
    - Acceptance: README status block present; no "Prowl QA" strings in the repo; backlog tiers reflect the decision.

68. **Sunset the `prowl-code-review-docs` site (review.prowl.tools)**
    As the owner, I want zero deploys to maintain for a personal tool, so that the only docs are the ones that live next to the code.
    - Port anything on the Docusaurus site that is not already in this repo's `docs/` (`getting-started`, `configuration`, `github-action`, `cli`, `bot-commands`, `ensemble`, `grounding`, `cross-file-context`, plus the self-hosted/Codex pages from #66) into `docs/` here as plain Markdown; `auth.md`, `privacy.md`, `example-review.md` already exist. Point the README "Documentation" section at `docs/`.
    - Remove the Vercel project and the `review` DNS record (a redirect to this repo's README for a grace period is fine). Deregister the `lucius-mac-mini-prowl-code-review-docs` runner, abandon its `prowl-review-codex` branch, then archive the `prowl-code-review-docs` repo with a retirement banner. This closes the docs-site half of #66 as won't-do; the `prowl-web` half is superseded by 69.
    - Update the `review.prowl.tools` badge/link in the README and the `docs` reference in the workspace `CLAUDE.md` subdomain list.
    - Acceptance: every page on the site has an equivalent in `docs/`; review.prowl.tools no longer serves the site; docs repo archived.

69. **Demote prowl-review on the marketing site**
    As a visitor to prowl.tools, I should see one product (the CLI), so that the site's promises match what is actually being built.
    - Counterpart item on the web side: `prowl-web` PQW-026. Either remove "Prowl Code Review" from the product lineup entirely or reduce it to a one-line "we also open-sourced the reviewer we run on our own PRs" footnote with a link to the repo. Owner decides which; the footnote is the recommended option (credibility signal at zero cost) provided the wording stays honest about maintenance mode.
    - Acceptance: no `/code-review` product page or equal-billing nav entry on prowl.tools; whatever mention remains links to the repo, not to a docs site.

70. **Homebrew formula and release process — decide keep-or-drop**
    As the owner, I want release overhead proportional to a personal tool, so that cutting a version costs minutes.
    - `homebrew-tap/Formula/prowl-review.rb` exists (the tap README does not list it). Either keep it and add it to the tap README truthfully, or delete the formula and its update step from `docs/releasing.md` and the publish workflow. Recommended: drop it — npm + the GitHub Action are the only channels the owner uses.
    - Trim `docs/releasing.md` to the steps still performed.
    - Acceptance: tap and releasing doc agree; no dead release steps.

71. **Finish #64 only for repos that survive the sunset**
    As the owner, I want the self-hosted rollout scoped to live repos, so that no runner is registered to an archived one.
    - Drop `prowl-hub`, `prowl-infra-hub`, and `prowl-code-review-docs` from #64's rollout list (their runner removal is tracked in each repo's own sunset section: HUB-018, INFRA-073, and item 68 above). Remaining scope: `prowl`, `prowl-web`, `prowl-docs`, this repo, and the owner's personal repos.
    - Acceptance: #64's status paragraph and the runner inventory on the Mac mini list only live repos.

---

Completed items live in [`docs/resolved.md`](./resolved.md). Consciously
deferred / blocked items (#46 GitLab/Bitbucket, #47 hosted App, #48 delegated-API
OAuth) are parked there with dates — see the "Deferred / parked" section. #45 (Codex
subscription provider) was un-parked on 2026-08-24 and **shipped** (completed
2026-08-24 — see resolved.md), as was its usage-limit resilience & zero-cost
reporting (#65, completed 2026-08-25 — see resolved.md). Its self-hosted rollout
(#64) remains in High Priority above.
