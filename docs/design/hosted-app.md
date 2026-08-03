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

The mission constraints are non-negotiable and inherited from the workspace:
**BYOK (the user's key pays the provider), no inference resale, no monetization
caps on BYOK inference, no data lock-in.** The managed service may enforce
published orchestration limits for abuse control, but those limits never apply to
the CLI, Action, App source, or self-hosting, and they never become a feature gate.

## Decision 0 — Hosted architecture and webhook intake

**Tension:** the hosted App has to feel instant, but duplicate webhooks, fork PRs,
and superseded heads must not trigger duplicate or out-of-order provider calls.

**Selected option:** build a thin, open-source webhook service around the **same
TypeScript core** the Action and CLI use. The reference managed runtime is
Cloudflare Workers + Queues for receiver/orchestration, with the runner tier
defined in Decision 2.

```text
PR opened/updated ──► GitHub webhook ──► receiver (verify signature)
                                              │
                                  persistent idempotency + leased claim
                                              │
                                        job queue (per-installation isolation)
                                              │
                                        review runner
                                          ├─ re-check current PR head + owner
                                          ├─ mint scoped installation token(s)
                                          ├─ load .prowl-review.yml from TRUSTED BASE branch
                                          ├─ agentic retrieval (Decision 2)
                                          ├─ LLM calls with the INSTALLATION'S OWN key (BYOK)
                                          └─ post review + branded "Prowl Review" check run
```

The receiver verifies the webhook signature, then records the GitHub delivery id
and a coalescing key of `{installation, repository, pull_request, head_sha}` before
enqueueing. Duplicate deliveries reuse the existing job record. Before work starts,
a runner atomically claims the job by writing a persistent lease with an expiry and
monotonic fencing token. Every provider call and publication re-reads the current
PR head, App installation state, delivery owner, revocation generation, and fencing
token; stale, expired, or superseded claims stop without posting review content.
Retries acquire a new fencing token, so concurrent deliveries cannot process the
same job simultaneously.

Fork-originated pull requests are **skipped by the managed App in v1**. The service
may post a neutral check or summary explaining the skip, but it makes no provider
call and does not run retrieval on fork content. A future maintainer opt-in path
requires a separate design update proving that trusted-base configuration, forced
workspace distrust, and sanitized context keep fork content from becoming an
implicit secret-bearing review path. The existing Action `pull_request_target`
pattern remains the deliberate fork-review escape hatch.

**Rationale:** persistent idempotency keeps retries cheap and deterministic; stale
guards prevent publishing on old heads; and the fork skip preserves the current
security posture while the hosted custody model is new.

**Rejected alternatives:** enqueueing before durable idempotency, using only
GitHub's delivery id without PR/head coalescing, reviewing forks automatically with
trusted-base config, and waiting for a full container checkout before shipping any
hosted path.

**Consequences:** the managed App starts with trusted in-repo PRs only, requires a
small persistence layer before the queue, and must expose superseded/skip states
clearly so users understand when no provider review ran.

## Decision 1 — Key custody: hosted convenience, self-hostable sovereignty

**Tension:** hosted BYOK means we hold users' provider keys, which is the custody
model the mission normally avoids.

**Selected option:** ship the App service **open source with a first-class
self-host path**, and run a managed instance of the same code.

- **Managed instance** (`app.review.prowl.tools` or similar): provider keys are
  stored in the database only as per-installation envelope-encrypted ciphertext.
  This is the one exception to the current Action/CLI environment-only key rule;
  it applies only to the managed hosted App and must be called out in SECURITY.md.
- **Self-hosted instance:** one-click deploy (Workers deploy button + Docker image).
  The operator registers their own GitHub App, holds their own provider keys and
  KMS material, and gets feature parity. Identical codebase; the managed instance
  is just our deployment of it.

**Managed key controls:** the envelope root key lives outside the application
database and outside queues, in a provider-managed KMS/HSM-style service with a
dedicated service identity. KMS administration is separate from database and runner
administration; no DB operator or runner can export root key material, and decrypt
grants are time-bound, audited, and scoped with encryption context/AAD containing
installation id, key row id, and job id. Break-glass grant changes require two
operators and expire automatically. Per-installation data keys wrap provider keys;
rotating the root key at least every 90 days re-wraps data keys, and suspected
compromise alerts operators within 5 minutes, disables decrypt access within 15
minutes, suspends new managed reviews for affected installations, and re-wraps or
destroys affected data keys within 4 hours before hosted reviews resume. Runners
receive decrypt permission only for the installation/job they are processing. Queue
messages carry installation, repo, PR, head SHA, and key row identifiers, never
plaintext keys or encrypted key blobs.

Plaintext provider keys exist only inside the runner process while constructing and
sending the direct provider request. The runner decrypts the key immediately before
the provider call, passes it to a minimal HTTP client that does not persist headers
or enable request debugging, and clears all references in a `finally` block after
the response body is fully consumed or the request errors. Mutable buffers are
zeroed best-effort, but Node/V8 cannot guarantee complete erasure of copied
strings or headers; per-job process isolation, no long-lived provider clients,
runner recycling after each job, disabled swap/core dumps/heap snapshots/process
inspection, and deployment only on platforms where those crash-dump controls can be
enforced are mitigations, not a guarantee that memory is clean. A native secret helper
with memory locking is a future hardening option, not an assumption in v1.

Residual risk is explicit: these controls protect against accidental persistence,
ordinary crash dumps, logs, traces, and reuse after a job exits. They do **not**
protect against host-level memory disclosure, a malicious infrastructure operator,
CPU side channels, a live runner compromise while the key is in use, or a provider
endpoint compromise. Users requiring that assurance should self-host the Docker
runner on hardware/runtime they control; the managed launch docs must disclose this
custody risk instead of presenting Node memory handling as a complete erasure
mechanism.

Every provider-call error path catches exceptions before any logging, redacts
authorization headers and known key patterns, and rethrows/logs only the redacted
message. HTTP-library debug logging is disabled in production. Launch-blocking CI
and staging tests must include canary provider keys and fail if those canaries
appear in logs, thrown errors, audit events, provider error summaries, traces,
provider request metadata, queue payloads, cache entries, or persisted state. The
same test suite must verify that decrypting an installation key fails after
revocation.

Keys are set through a settings UI authorized by explicit GitHub permissions:
org-owner permission for org installations, repository-admin permission for
repo-only/user installations, or an audited installation-admin allowlist maintained
by those admins. The installing user is recorded but is not the only permanent
admin. `@prowl-review configure key` never accepts a raw key in a public comment; it
only opens a short-lived, single-use settings link after the command authorization
in Decision 5 succeeds. The UI never displays plaintext keys after save.

**Deletion and revocation:** overwrite rotates the encrypted key row and emits an
audit event. Delete/uninstall immediately marks the installation revoked, bumps the
revocation generation, disables decrypt access, invalidates outstanding job leases
and fencing tokens, cancels queued jobs, signals active runners to stop, evicts
runner/cache entries, deletes provider key rows and review state, and writes a
deletion audit event. Active runners check the revocation generation and fencing
token immediately before every external call and before publication; a revoked
runner drops any plaintext key reference and exits without posting. Logs keep only
redacted operational events. Backups remain encrypted and become cryptographically
unusable once wrapping keys are destroyed; backup copies expire on the published
30-day retention schedule. GitHub comments/checks already posted to the user's
repo are not deleted automatically because they are user-visible repository history.

**Rationale:** this preserves the install-once UX while making the custody boundary
explicit and verifiable. Self-hosting remains the sovereignty answer for users who
do not want Prowl to hold encrypted keys at all.

**Rejected alternatives:** environment-only keys for the managed App (not compatible
with install-once UX), plaintext keys in queues or job payloads, a closed-source
hosted service, and asking users for broad personal GitHub tokens.

**Consequences:** the managed instance carries real security/compliance obligations:
KMS operations, deletion jobs, audit access, key-leak tests, and settings UI
authorization are launch blockers rather than implementation details.

## Decision 2 — Retrieval: bounded API-first now, sandbox tier later

**Tension:** the #1 differentiator (agentic cross-file retrieval) and the #3 one
(linter/SAST grounding) assume a local checkout. A Workers runtime has no
filesystem, and API retrieval can hit rate, latency, and completeness limits.

**Selected option:** phase retrieval, with explicit v1 bounds.

- **v1 (API retrieval):** implement the agentic grep/read tool surface against
  GitHub REST/GraphQL APIs using a request-scoped, read-only installation token
  minted separately from the posting token. The token is limited to the installed
  repository and required read permissions only. Private dependencies outside the
  installed repo are out of scope for v1; adding optional broader credentials is a
  separate decision.
- **v1 endpoints:** read uses blob/contents APIs by exact path/ref; changed-file
  discovery and repository tree traversal use bounded pagination with an explicit
  page ceiling. Every page, retry attempt, response byte, and retrieved byte counts
  against the request, response-size, and timeout ceilings below. The adapter treats
  Git tree `truncated` responses, incomplete PR-file pagination, and missing
  required blobs as completeness failures. Grep/find-reference behavior runs only
  over the proven-complete bounded tree/file cache. GitHub code search is disabled
  for private repositories in v1 because it exposes repository content to GitHub's
  global search index, which has different access-control semantics than
  fine-grained repository reads. Public-repo search is disabled by default and
  opt-in only to avoid excessive API load. Future retrieval of GitHub Advanced
  Security findings must not expose secret-scanning or custom-pattern findings
  through code search or any externally indexed surface.
- **Bounds:** each review has a bounded LRU cache keyed by `{head_sha, tool, path,
  query}` with launch defaults of 128 MiB or 2,000 entries, whichever comes first.
  The runner also starts with a 1,000-request retrieval ceiling, 25 MiB aggregate
  API response ceiling, 1 MiB per-file read ceiling, and 90-second retrieval
  timeout per review. A typical small PR should need one tree read plus changed
  file reads and fewer than 100 follow-up grep/read calls; large monorepos may hit
  the explicit incomplete-review path below. Launch docs publish the effective
  limits and any beta adjustments.
- **Rate and failure behavior:** the runner checks remaining GitHub rate budget
  before search-heavy work, applies bounded retry/backoff for `Retry-After` and
  secondary-rate-limit responses, and stops retrieval before starving other jobs
  for the same installation. Bounded, known partial context is reported as a
  clean-with-caveat review. If required changed-file retrieval fails, permissions
  are denied, response sizes exceed bounds, the rate state is exhausted, or
  completeness is unknown, the review is marked **Review incomplete**, approval is
  withheld, and the output names the missing context.
- **Security parity:** the API adapter rejects symlinks, submodules, traversal
  outside the installed repo, sensitive files, and over-limit files using the same
  redaction and skip-reporting invariants as local retrieval.
- **v2 (sandbox tier):** ephemeral per-review containers (Cloudflare Containers or
  equivalent) doing a shallow clone; restores full grounding parity and native grep
  semantics. Gated on real usage data justifying the cost/complexity.
- **Self-hosted Docker deployments:** full parity immediately, because they have a
  real filesystem and use the existing local-checkout path from day one.

**Rationale:** API-first delivers install-once reviews without container
infrastructure, while explicit bounds keep large repos from becoming unbounded
memory, latency, or rate-limit failures.

**Rejected alternatives:** shipping unbounded API traversal, treating partial
retrieval as complete, requiring user PATs for private dependency traversal, and
blocking the hosted launch until container grounding exists.

**Consequences:** managed v1 reviews are weaker than Action/Docker reviews: no
linter/SAST grounding and bounded API context. The review output must say so every
time those limits affect coverage.

## Decision 3 — Free/paid boundary

**Tension:** the Action costs us nothing, so "free forever" is trivially credible
there. A managed service has small but real compute/storage costs plus abuse
surface.

**Selected option:**

- **Free forever, guaranteed in writing:** the CLI, the Action, the App source, and
  self-hosting. These carry the mission and are never revenue-gated.
- **Managed instance: free at launch.** Published fairness limits apply only to the
  hosted orchestration layer: per-installation active-job concurrency, queue depth,
  webhook token bucket, dead-letter threshold, and the existing user-visible
  per-review provider budget guard. They are not product-tier caps on what the
  user's provider key may do, and they do not apply to self-hosted deployments.
- **Launch defaults:** start with 1 active review and 10 queued reviews per
  installation, a 60 accepted-webhook-events/hour token bucket, a 30-minute job
  timeout, and dead-letter after 3 consecutive runner failures for the same job.
  Operators may tune these globally during beta, but every change must remain
  published and audited.
- **Limit behavior:** duplicate webhooks coalesce; concurrency excess queues with a
  `retry_after`/pending status; abusive webhook bursts are rejected before provider
  calls with a neutral check or explanatory summary; per-review budget exhaustion
  ends as **Review incomplete** with approval withheld. No limit silently degrades
  context or pretends a review completed.
- **Configuration and observability:** default values are globally tunable by
  operators and published in launch docs. Installation admins can view limit hits,
  queued jobs, and incomplete-review reasons in the settings UI. Repeated limit
  hits emit operator alerts and audit events.

If managed-instance costs become material, the paid boundary is the managed
convenience tier (hosting, support, SLAs), never inference resale, never withheld
self-host features, and never caps on the user's own provider usage in the open
source paths.

**Rationale:** fairness limits protect a free hosted queue from accidental or
malicious load while preserving the BYOK economic promise.

**Rejected alternatives:** monetizing inference, feature-gating self-hosting,
silently throttling reviews, or applying hosted limits to the Action/CLI.

**Consequences:** the hosted service needs visible queue/limit state, retry
semantics, and operator dashboards before launch.

## Decision 4 — State, isolation, audit, and abuse controls

**Tension:** the App needs enough state to avoid duplicate reviews and support key
custody, but storing review content would violate the current privacy posture.

**Selected option:** persist only operational state, with tenant isolation and an
append-only audit log.

- **Persistence (D1/Postgres, small):** installations (org, repo set, App install
  id), encrypted provider key rows, delivery-owner cache records (Decision 5), per-repo
  review state (marker/review ids, posted finding fingerprints, learnings
  pointers), webhook idempotency records, queue/dead-letter metadata, deletion
  jobs, and audit events.
- **Privacy invariant:** no diff contents, API-retrieved file contents, review
  bodies, `issue_comment` bodies, thread context, logs, prompts, provider
  responses, or provider payloads are stored as durable content. Content payloads
  from API retrieval, commands/comments, thread context, generated review text,
  logs, prompts, provider responses, and persisted representations pass through the
  shared redaction boundary before storage, publication, logging, or provider
  transmission. Credential-bearing transport headers are attached only at the
  transport boundary and sent unchanged only to the intended provider or GitHub API;
  authentication headers are never logged, stored, audited, traced, or included in
  provider request metadata. Shared queues and durable/shared caches may contain
  only approved operational metadata; API response bodies and diff content live only
  in runner memory, and the runner-local retrieval cache stores redacted content
  only. Redaction counts remain reportable; secret values do not.
- **Tenant isolation:** every queue message, DB row, cache key, audit event, and
  runner credential is keyed by installation id. Runners process one installation's
  job with only that installation's decrypted provider key and scoped GitHub token
  in process. No cross-tenant batching.
- **Audit events:** installation create/delete, repository enable/disable,
  delivery-owner changes, key create/update/delete, failed authentication, command
  authorization failure, review start/complete/incomplete, fairness-limit hits,
  deletion jobs, unplanned termination, and staff access. Events include timestamp,
  actor, installation, repository/PR when applicable, action, outcome, and reason.
- **Retention/access:** audit logs are append-only, retained for at least 180 days,
  and scoped by GitHub App installation id. Installation admins may export audit
  logs only for installation ids they administer and only for the repositories in
  that installation. Staff cross-installation or aggregate audit access requires
  time-bound approval, is separately audited, and never grants plaintext provider
  key access.
- **Webhook verification:** all webhooks require GitHub `X-Hub-Signature-256`
  HMAC-SHA256 verification using active App webhook secret(s) and constant-time
  comparison. MD5/SHA1 signatures are rejected. Webhook secrets rotate at least
  every 90 days or immediately on suspected compromise; the previous secret is
  accepted for at most 24 hours for in-flight retries. Delivery ids are recorded
  with a replay TTL before enqueueing. Initial provisioning and rotation happen
  through the App settings flow: the new secret is written to the App secret store
  and marked pending before GitHub is updated, then marked active only after a
  signed test delivery verifies it. Manual GitHub-UI webhook secret rotation is not
  supported; if the GitHub secret and stored active secret diverge, webhooks fail
  closed and installation admins must resynchronize through the App settings flow.
- **Abuse controls:** per-installation queue depth/concurrency, webhook token
  bucket, dead-letter + alerting on repeated failures, and stale-head close-out so
  a misbehaving repo cannot spin the queue or publish outdated reviews.

**Rationale:** operational state is necessary for reliability, but the same
privacy line that exists today still holds: durable systems do not become a code,
prompt, or review-content warehouse.

**Rejected alternatives:** storing full prompts/provider payloads for debugging,
mutable audit logs, shared runner credentials across installations, and relying on
webhook retries without local replay/idempotency state.

**Consequences:** debugging must rely on redacted traces, structured outcomes, and
short-lived runtime inspection rather than durable raw content.

## Decision 5 — Migration path, identity, and command authorization

**Tension:** the hosted App should feel like the existing Action, but bot identity,
check runs, command webhooks, and dual delivery can create duplicate reviews if the
ownership model is ambiguous.

**Selected option:** reuse the existing `prowl-review` GitHub App identity for the
managed hosted App. Existing summary markers continue to be recognized only when
they were authored by the authenticated `prowl-review[bot]` login; a one-time
migration job may read prior `github-actions[bot]` marked summaries and copy only
their redacted state marker into the hosted review state, but it does not edit old
comments. Check runs remain tied to their original GitHub run ids and are not
migrated; the App creates or completes only its own `Prowl Review` check for the
current head.

Uninstalling the `prowl-review` App immediately disables hosted reviews and token
minting for Action workflows that depend on that App. Existing Action workflows
fall back to `GITHUB_TOKEN` only when they are written with the current tolerant
token-minting path; otherwise they fail visibly until the App is reinstalled or the
workflow is reconfigured.

**Delivery ownership:** the shared authority is GitHub-backed, not a private hosted
database row: the trusted-base `.prowl-review.yml` gains `delivery.owner: action |
app`. The hosted installation store may cache the last observed owner for the UI,
but it cannot override the trusted-base config. If the field is absent, setup uses
a deterministic fallback: App defers when an Action workflow is present, and App
owns only when no Action workflow is detected. Workflow-file detection is only this
bootstrap fallback; it cannot override an explicit config owner.

Before hosted launch, the Action must learn this field from the same trusted-base
config it already loads and exit with a neutral "App owns delivery" result before
any provider call when `delivery.owner: app`. The hosted App performs the symmetric
check and no-ops when `delivery.owner: action`. Owner changes apply to the next PR
head SHA. Subsequent deliveries for existing PR heads re-query the owner before
enqueueing; in-flight reviews under the previous owner are marked superseded and
stopped before publication if ownership changed. The idempotency key includes the
owner: `{installation, repository, pull_request, head_sha, owner}`, and both
delivery paths re-check the owner before provider calls and publication. This
Action/App owner check is a launch blocker for dual-delivery support.

**Command authorization:** the `@prowl-review` command surface moves to
`issue_comment`/`pull_request_review_comment` webhooks with the same verbs, but
commands are honored only when all checks pass:

1. The comment belongs to a pull request in a repository covered by the active App
   installation.
2. The sender has repository `write`, `maintain`, or `admin` permission, verified
   through GitHub APIs; `configure key` additionally requires installation admin
   authorization in the settings UI.
3. The webhook signature, delivery id, comment id, edited timestamp/body digest,
   installation id, repository id, PR number, and current head SHA match the
   idempotency record for the command. Delivery-id replay records live for 24
   hours, and state-changing/costly commands are rate-limited to 5 commands per
   minute per `{installation, user, pull_request, command}` before any provider
   call. Violations are rejected, audited, and alerted on repeated abuse.
4. The command is in the explicit current allowlist: `review`, `full review`,
   `break glass`, `ignore`, `resolve`, per-PR `configure`, `pause`, `resume`,
   `docstrings`, `tests`, `help`, chat replies, and `configure key` link creation.
   No command executes repository code or arbitrary shell, and fork PRs still
   follow Decision 0's managed skip policy.

`configure key` link creation is not sufficient to save a key. The settings link is
bound to `{installation, repository, sender, comment_id, nonce}`, expires in 10
minutes, is single-use, requires fresh GitHub OAuth/App authorization with the
installation-admin definition above, carries no key material in the URL, and uses
standard CSRF/state validation before accepting a provider key.

**Rationale:** reusing the bot identity preserves update-in-place behavior for
current `prowl-review[bot]` summaries, while shared delivery-owner config prevents
both the Action and App from starting reviews for the same PR head.

**Rejected alternatives:** registering a sibling cloud App with a different bot
login, treating hidden markers as delivery-agnostic regardless of author, deciding
delivery precedence from live workflow-file detection, and accepting commands from
any commenter with a syntactically valid mention.

**Consequences:** hosted launch requires delivery-owner config/cache support, owner
checks in both delivery paths, command replay records, and an installation-admin
settings flow before command parity is considered complete.

## Build plan (when approved)

1. Receiver + queue + installation store + persistent idempotency, using the
   existing `prowl-review` App identity for the managed instance.
2. Trusted-base `delivery.owner` config plus Action/App owner checks so dual
   delivery cannot start duplicate reviews.
3. Managed key settings UI, envelope encryption, KMS access controls, audit log,
   and deletion lifecycle.
4. API-retrieval adapter for the core's repo-tools interface with the Decision 2
   bounds and incomplete-review states.
5. Runner + posting path (core unchanged) + command authorization/replay handling.
6. Self-host packaging (Workers deploy button + Dockerfile) and SECURITY.md/docs.
7. Beta on our own repos → publish policy docs/limit defaults → announce.

Each step lands as its own backlog item once #47 is un-parked; this doc's approval
is the gate.
