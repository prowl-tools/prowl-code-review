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
    - **Done (contributor ergonomics & discoverability):** README status/license/CI/Node/PRs/docs badges, `.editorconfig`, `.nvmrc` (Node 22.13.0 pin), and `.github/dependabot.yml` (weekly npm + github-actions updates, grouped dev bumps). Added the **npm version badge** now that `0.1.0` is published (#42).
    - Acceptance (remaining): a **demo GIF / screen capture** of a live review (binary asset), and a standalone **example/demo repo** (separate repository) that shows prowl-review running end-to-end.

62. **Hosted GitHub App design doc (revival gate for parked #47)**
    _Status: doc drafted at [`docs/design/hosted-app.md`](./design/hosted-app.md) (branch `hosted-app-design-doc`) — pending maintainer review. The decision log now records selected options, rationale, rejected alternatives, and consequences for hosted architecture, key custody, retrieval, free/paid boundary, state/isolation/audit, migration identity, delivery ownership, and command authorization, with an explicit #62 coverage table tying each backlog decision to its record; #47 stays parked until the doc is approved, then this item moves to resolved._
    As the product owner, I want the Phase-2 hosted-App decisions resolved on paper before any code, so that #47 (install-once hosted App) can be revived with a clear, mission-consistent build plan.
    - The resolved decisions: (1) **key custody** — hosted BYOK uses an open-source, self-hostable service plus managed per-installation envelope encryption; (2) **retrieval strategy** — managed v1 uses bounded GitHub API retrieval, with sandboxed checkout parity later and Docker self-host parity immediately; (3) **free/paid boundary** — Action/CLI/App source/self-host stay free forever, while the managed tier launches free with published orchestration fairness limits that are not BYOK monetization caps.
    - Also covered: webhook receiver architecture (raw-header-preserving intake with Cloudflare Workers + Queues only as post-verification orchestration), abuse controls, state/persistence, key rotation/revocation/deletion, least-privilege access, tenant isolation, audit retention, migration identity, deterministic Action/App delivery ownership, command authorization, and the migration path from the Action (same core, second delivery wrapper).
    - Acceptance: a `docs/design/hosted-app.md` with a decision log covering the above; for every listed decision — Phase-2 key custody, retrieval, and free/paid boundary; webhook architecture; abuse controls; state/persistence; secret lifecycle; least-privilege access; tenant isolation; and migration from the Action — the log records the selected option, rationale, rejected alternatives, and consequences; #47 stays parked until all required decisions meet that bar and the doc is reviewed/approved — this item is the doc, not the build.

---

Completed items live in [`docs/resolved.md`](./resolved.md). Consciously
deferred / blocked items (#45 Codex subscription, #46 GitLab/Bitbucket, #47 hosted
App, #48 delegated-API OAuth) are parked there with dates — see the "Deferred /
parked" section.
