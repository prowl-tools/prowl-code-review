# Design: Hosted GitHub App (Phase 2)

**Status: PROPOSED — pending maintainer review.** This document is backlog **#62**, the
revival gate for parked **#47** (install-once hosted GitHub App). Per the workspace
policy, #47 stays parked until the decisions below are approved; approving this doc
un-parks it with a build plan. Nothing here changes the Action/CLI delivery.

## Why a hosted App at all

The Action path is proven (branded identity #59, live gated check run #24/#107,
single-row presentation #61), but three things only a hosted App can deliver:

1. **Install-once UX** — two clicks + one API key; no workflow files, no secrets
   plumbing, no CI coupling. This is how CodeRabbit onboards, and it is the largest
   remaining adoption gap.
2. **Works where Actions doesn't** — orgs that restrict or disable GitHub Actions,
   and repos that simply have no CI to chain from.
3. **Instant reviews** — no runner spin-up, no waiting for CI to complete.

The mission constraints are non-negotiable and inherited from the workspace: **BYOK
(the user's key pays the provider), no inference resale, no usage caps we impose, no
data lock-in.** Every decision below is evaluated against them.

## Architecture overview

A thin, open-source webhook service wrapping the **same TypeScript core** the Action
and CLI use. The core is untouched; this is delivery wrapper #3.

```
PR opened/updated ──► GitHub webhook ──► receiver (verify signature, enqueue)
                                              │
                                        job queue (per-installation isolation)
                                              │
                                        review runner
                                          ├─ mint installation token (App key)
                                          ├─ load .prowl-review.yml from TRUSTED BASE branch (unchanged)
                                          ├─ agentic retrieval (Decision 2)
                                          ├─ LLM calls with the INSTALLATION'S OWN key (BYOK)
                                          └─ post review + branded "Prowl Review" check run (existing core)
```

Reference runtime: **Cloudflare Workers + Queues** for receiver/orchestration
(near-zero idle cost, generous free tier — the "our marginal cost stays ~zero"
property the mission's economics depend on), with the runner tier per Decision 2.
The service is **stateless per review** except for the persistence in Decision 4.

## Decision 1 — Key custody: hosted convenience, self-hostable sovereignty

**The tension:** hosted BYOK means we hold users' provider keys — exactly the custody
model the mission positions against.

**Decision (proposed):** ship the App service **open source with a first-class
self-host path**, and run a managed instance of the same code.

- **Managed instance** (`app.review.prowl.tools` or similar): keys stored encrypted at
  rest (per-installation envelope encryption; KMS-style master key outside the DB),
  decrypted only in the runner for the duration of a review, never logged, never
  proxied through additional services (LLM calls remain direct provider calls, as the
  privacy docs promise today).
- **Self-hosted instance**: one-click deploy (Workers deploy button + Docker image).
  The operator registers their *own* GitHub App, holds their own keys, and gets full
  parity. Identical codebase; the managed instance is just our deployment of it.

This turns the custody tension into the differentiator: *hosted by us for
convenience, self-hostable for sovereignty, same core either way.* No competitor
offers the spectrum.

**Key lifecycle (managed):** keys are set via a minimal settings UI or a
`@prowl-review configure key` flow; rotation = overwrite; revocation = delete
(hard-delete row + audit event); uninstalling the App cascades deletion of the
installation record, its key, and its review state within 24h. Least privilege: the
App requests only `pull-requests:write`, `checks:write`, `issues:write`,
`contents:read`, metadata — the same scopes the #59 App holds today.

## Decision 2 — Retrieval: API-first now, sandbox tier later

**The tension:** the #1 differentiator (agentic cross-file retrieval) and the #3
one (linter/SAST grounding) assume a local checkout. A Workers runtime has no
filesystem.

**Decision (proposed): phase it.**

- **v1 (API retrieval):** implement the agentic grep/read tool surface against the
  GitHub REST/GraphQL APIs (contents, git trees, code search) with an in-memory
  cache per review. This preserves cross-file context — the #1 lever — with zero
  container infrastructure. **Grounding (ESLint/Semgrep/Gitleaks) is skipped in v1
  and reported in the review** per the no-silent-truncation principle ("linter
  grounding unavailable in hosted mode" note), exactly as the core already reports
  skipped content.
- **v2 (sandbox tier):** ephemeral per-review containers (Cloudflare Containers or
  equivalent) doing a shallow clone; restores full grounding parity and native grep
  semantics. Gated on real usage data justifying the cost/complexity.
- **Self-hosted Docker deployments get full parity immediately** — they have a real
  filesystem, so the runner uses the existing local-checkout path from day one.
  (Self-host on Workers shares v1's API-retrieval limits.)

Consequence to accept openly: in v1, the managed instance's reviews are slightly
weaker than Action reviews (no linter grounding). The review output says so — users
who want full parity keep the Action or self-host with Docker. This is honest and
temporary; the alternative (shipping nothing until containers are built) delays the
install-once UX for a feature many repos don't configure anyway.

## Decision 3 — Free/paid boundary

**The tension:** the Action costs us nothing, so "free forever" is trivially
credible there. A managed service has real (small) compute/storage costs that scale
with adoption, plus abuse surface.

**Decision (proposed):**

- **Free forever, guaranteed in writing:** the CLI, the Action, the App *source*,
  and self-hosting. These carry the mission and are never revenue-gated.
- **Managed instance: free at launch**, with published *fairness* limits that exist
  for abuse control, not monetization (per-installation concurrency cap, per-PR
  budget cap reusing the existing config, webhook rate limiting). BYOK means our
  per-review cost is orchestration-only — cents per thousand reviews on the
  Workers free/paid tier. Revisit only if managed-instance costs become material;
  if that day comes, the boundary is **the managed convenience tier** (hosting,
  support, SLAs) — never inference, never caps on what the user's own key can do,
  and never features withheld from self-host.
- Publish this policy in the docs the day the App ships, so the commitment is
  auditable and the CodeRabbit-contrast stays sharp.

## Decision 4 — State, isolation, and abuse controls

- **Persistence (D1/Postgres, small):** installations (org, repo set, App install
  id), encrypted provider keys, per-repo review state (the same review-state
  records the Action persists today — marker/review ids, learnings pointers), audit
  log (installs, key changes, deletions). **No diff contents, no review bodies, no
  provider payloads are stored** — parity with today's privacy posture.
- **Tenant isolation:** every queue message and DB row is keyed by installation id;
  runners process one installation's job with only that installation's decrypted
  key and installation token in scope. No cross-tenant batching.
- **Abuse/cost controls:** per-PR budget cap (existing core feature) enforced as a
  hosted default; per-installation concurrency (queue depth) limits; signature-
  verified webhooks only; dead-letter + alerting on repeated failures so a
  misbehaving repo can't spin the queue.

## Migration path & compatibility

- The App posts through the **same core presentation** (single cohesive review,
  branded check run, update-don't-duplicate), so a repo can switch Action ⇄ App
  and prior reviews keep updating correctly (markers/review ids are delivery-
  agnostic).
- `.prowl-review.yml` remains the single config surface, still loaded from the
  trusted base branch. No new config format.
- Repos with both the App installed and the Action workflow present: the App
  detects the workflow file and defers (or vice versa via config flag) — exact
  precedence rule to be settled during implementation; default proposal: **explicit
  config wins, App defers to a present workflow otherwise** (no double reviews).
- The `@prowl-review` command surface moves to webhooks (`issue_comment`) with the
  same verbs; command parity is a launch requirement, not a follow-up.

## Build plan (when approved)

1. Receiver + queue + installation store, managed App registration (reuse the #59
   App or a sibling "Prowl Review Cloud" App — settle during implementation).
2. API-retrieval adapter for the core's repo-tools interface (the seam already
   exists — the CLI injects local grep/read; the App injects API-backed ones).
3. Runner + posting path (core unchanged) + settings/key flow + deletion lifecycle.
4. Self-host packaging (Workers deploy button + Dockerfile) and docs.
5. Beta on our own repos → publish policy docs → announce.

Each step lands as its own backlog item once #47 is un-parked; this doc's approval
is the gate.

## Open questions for the maintainer

1. Managed App identity: reuse the existing `prowl-review` App (one identity
   everywhere) or register a separate cloud App so Action-only users' trust surface
   is unchanged?
2. Is the v1 grounding gap (reported, not silent) acceptable for the managed
   instance at launch?
3. Any hard requirement for a non-Cloudflare reference stack (e.g. plain
   Node/Docker first, Workers as an optimization)?
