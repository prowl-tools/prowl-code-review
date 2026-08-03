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
before enqueueing. Delivery id deduplicates exact GitHub retries only; review
eligibility is tracked separately with a coalescing key of `{installation,
repository, pull_request, head_sha, lifecycle_generation}`. The lifecycle
generation increments on state transitions that can make the same head newly
reviewable or newly owned, including `ready_for_review`, `reopened`, base-branch
changes, `delivery.owner` changes, key configuration, and resume/unpause actions.
Terminal skipped states can therefore be re-armed without treating a real state
transition as a duplicate retry. Duplicate deliveries for the same lifecycle
generation reuse the existing job record. Before work starts, a runner atomically
claims the job by writing a persistent lease with an expiry and monotonic fencing
token. Every provider call and publication re-reads the current PR head, App
installation state, delivery owner, revocation generation, and fencing token;
stale, expired, or superseded claims stop without posting review content. Retries
acquire a new fencing token, so concurrent deliveries cannot process the same job
simultaneously.

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
database and outside queues, in a provider-managed KMS/HSM-style service. The
boundary is enforced by provider IAM/HSM policy, infrastructure-as-code policy
tests, and drift alerts rather than by a manual runbook alone:

- Key-admin identities may create, rotate, disable, and schedule destruction of
  wrapping keys and grants, but they cannot decrypt provider keys or read the
  application database.
- Runner-decrypt identities may decrypt only through a per-job grant whose
  encryption context/AAD exactly matches installation id, key row id, job id,
  provider name, provider-call nonce, revocation generation, and fencing token.
  They cannot list, export, rotate, or re-wrap keys. The provider-call nonce is
  allocated by the control plane in the same transaction that checks the active job
  lease/fencing token and advances a per-job counter; runners cannot choose or reuse
  it. A decrypt broker issues one decrypt authorization for that allocated nonce,
  marks it consumed before returning plaintext, and rejects stale/replayed nonces,
  including after runner crashes or network retries. Each provider API request or
  retry therefore requires a fresh decrypt authorization; the decrypted key is used
  to construct exactly one outbound provider attempt and then cleared in `finally`
  before any subsequent retry or provider call can start. This adds KMS latency/cost
  but prevents a normal runner path from reusing one decrypt across multiple calls;
  it does not protect against a runner already compromised during that authorized
  call.
- Rewrap/deletion workers may re-wrap or destroy affected data keys for an
  approved incident/deletion job, but they cannot call providers or GitHub as a
  review runner.
- Backup/restore identities may copy encrypted snapshots only. Restored data
  remains undecryptable until a new KMS grant is approved and audited.

KMS `Decrypt`, `GenerateDataKey`, `ReEncrypt`, `CreateGrant`, `RevokeGrant`, and
key disable/destroy events go to the provider's immutable audit stream, separate
from the app audit log. Alerts fire on decrypt outside an active job, AAD mismatch,
unexpected grant creation, policy drift, or disabled audit delivery. A compromised
runner credential can decrypt only the active installation/job grant, not all
installations. A KMS administrator can deny service or rotate keys but cannot
decrypt provider keys without the two-operator break-glass path, which expires
automatically and is separately audited. Per-installation data keys wrap provider
keys; rotating the root key at least every 90 days re-wraps data keys. Suspected
scoped compromise disables affected decrypt grants immediately and alerts operators
within 5 minutes; broad or critical wrapping-key compromise freezes all affected
managed decrypts within 15 minutes. Re-wrap/destruction begins immediately, affected
installations stay suspended until it completes, and the 4-hour target is a maximum
restoration objective for scoped events, not a period where compromised grants keep
working. These incident timers are post-detection containment for future decrypts
and stored ciphertext; they do not undo plaintext exposure from a live compromised
runner. Queue messages carry installation, repo, PR, head SHA, and key row
identifiers, never plaintext keys or encrypted key blobs.

Each encrypted provider-key row is an authenticated envelope, not just ciphertext.
The envelope metadata commits to installation id, key row id, provider name, data
key id, key version, and creation generation, and it stores a KMS/HSM-backed HMAC
tag over that metadata plus the plaintext key bytes. After decrypt, the runner asks
KMS/HSM to verify the non-exportable HMAC tag against the requested envelope
metadata before using the key. A metadata mismatch, tag failure, or unexpected key
row/provider pairing fails closed, revokes the job grant, and emits an audit event;
the runner never sends a provider request with a key whose envelope does not match
the installation being processed.

Plaintext provider keys exist only inside the runner process while constructing and
sending the direct provider request. Most critically, a compromised runner process
while decrypting or sending the provider request exposes the plaintext key in
memory; no Node/V8 mitigation can prevent that. The managed v1 boundary is therefore
not suitable for users who require protection against live runner compromise,
host-level memory disclosure, malicious platform operators, CPU side channels, or a
provider endpoint compromise. Those users should self-host the Docker runner on
hardware/runtime they control; a native secret helper or sidecar vault with
memory-locking is required before Prowl can claim stronger live-custody protection
for the managed service. The controls below reduce accidental persistence,
ordinary crash dumps, logs, traces, and reuse after a job exits.

Provider endpoint compromise is also outside Prowl's control. The managed App
sends the user's BYOK credential to the user's chosen provider over normal provider
authentication, so a compromised provider endpoint, provider-side logging system,
or TLS interception outside Prowl's trust boundary can capture the key or review
content. The App must enforce TLS certificate validation, no custom CA bypasses,
and no local SDK debug logging, but it cannot force provider-side redaction or
per-request credentials unless the provider supports them. Launch docs must direct
users to provider-side key scoping, spend limits, monitoring, and rotation; users
who do not trust a provider with their key should not use that provider through the
managed App.

For each provider API attempt, the runner decrypts the key immediately after the
final revocation/fencing check and immediately before request construction. The key
is passed to a minimal HTTP client that does not persist headers, buffer
authorization data beyond the active request, or enable request debugging. The
attempt is wrapped in a `try/finally`; if request construction, send, streaming, or
response handling fails, the `finally` block clears all runner references before any
retry can begin, and every retry must obtain a fresh provider-call nonce/decrypt
authorization. Credentials must stay out of prompts, provider request bodies,
serialized URLs, structured error metadata, and generic exception inspection.
Mutable buffers are zeroed best-effort, but Node/V8 cannot guarantee complete
erasure of copied strings, headers, or HTTP-client internals; per-job process
isolation, no long-lived provider clients, mandatory runner recycling after every
job before any other installation's work, disabled swap/core dumps/heap
snapshots/process inspection, startup self-checks for those controls, and
deployment only on platforms where crash-dump controls can be enforced are
mitigations, not a guarantee that memory is clean.

The provider HTTP client is a launch-blocking security component: use a minimal
audited client or in-house wrapper with no middleware cache, no automatic request
object retention, no SDK-level retries carrying prior request objects, no debug
hooks, and no logging of serialized request/response objects. Tests must include
post-attempt canary scans of available heap/debug artifacts in staging; a canary
present after `finally` completes blocks launch until the client/wrapper is
replaced or patched. A canary may still be observable while the request is active;
that live-process exposure is the explicit residual risk above.

The runner isolation boundary is an OS process per review job, not just a queueing
convention. Even two jobs for the same installation run in separate processes, and
concurrency uses additional isolated processes rather than batching keys in one
process. The managed runner tier must launch with swap disabled, core dumps
disabled, Node inspector/heap snapshots unavailable, process inspection denied, an
ephemeral filesystem, and an equivalent hardened sandbox policy such as
seccomp/AppArmor/gVisor/Firecracker for the chosen platform. If the startup
self-check cannot verify those controls, the runner fails closed before decrypting.
Launch-blocking staging tests deliberately exercise canary-key provider calls,
provider errors, runner crashes, attempted debug/snapshot paths, and post-job
process exit; they verify no canary reaches captured logs, audit events, queues,
caches, persisted state, provider error summaries, process environment snapshots,
or crash-dump locations. These tests verify the operational controls only; they do
not prove safety against live host/process compromise.

Every provider-call error path, including key decrypt, request construction,
network timeout, response streaming, malformed provider response, provider 4xx/5xx,
and local HTTP-library failure, catches exceptions before any logging, drops the
original exception object from log/audit serialization, and constructs an
allowlisted sanitized error from status code, provider error class, retryability,
and request id only. The original error is not re-thrown across the runner boundary.
Provider request/response bodies, headers, stack traces, raw URLs, and SDK debug
objects are not logged or retained in client/cache state. HTTP-library debug logging
is disabled in production. Launch-blocking CI and staging tests must include canary
provider keys and provider mocks that echo those keys in headers, URLs, bodies,
timeout errors, malformed responses, thrown errors, exception stack traces,
structured exception objects, exception causes, logger serialization, middleware
caches, retry/backoff state, request builders, transient object references, and any
enabled Node/V8 tracing output. The tests fail if canaries appear in stdout,
stderr, structured logs, exception messages/stacks, audit events, provider error
summaries, traces, provider request metadata, queue payloads, cache entries, or
persisted state. Startup/staging checks must also verify that Node debugging,
inspection, heap snapshot, and tracing interfaces are disabled or blocked before
any provider key can be decrypted. The same test suite must verify that decrypting
an installation key fails after revocation.

Keys are set through a settings UI authorized by explicit GitHub permissions:
org-owner permission for org installations, repository-admin permission for
repo-only/user installations, or an audited installation-admin allowlist maintained
by those admins. The installing user is recorded but is not the only permanent
admin. `@prowl-review configure key` never accepts a raw key in a public comment; it
only opens a short-lived, single-use settings link after the command authorization
in Decision 5 succeeds. The link is an HTTPS-only App URL protected by HSTS, contains
only an opaque random nonce whose server-side record stores a hash, and is redacted
from application logs. The settings page serves no third-party assets, sends
`Referrer-Policy: no-referrer`, uses `Secure`, `HttpOnly`, `SameSite=Lax` or stricter
session cookies, and requires an explicit CSRF token tied cryptographically to the
nonce and authenticated session; SameSite cookies are defense-in-depth, not the
CSRF control. The key-save transaction consumes the nonce atomically with an
`UPDATE`/`DELETE ... WHERE consumed_at IS NULL` or equivalent unique constraint
before persisting the key, so concurrent submissions cannot reuse the link. A
leaked link cannot save a key without the fresh GitHub OAuth/App authorization
described in Decision 5. The UI never displays plaintext keys after save.

The key-save endpoint is rate-limited before validation by installation, user
session, and source address. It performs constant-shape local format validation and,
where the provider supports it, a minimal live auth probe over the same sanitized
provider-call path before marking the key verified. If live validation fails or is
unsupported, the response is generic and never re-renders or logs the submitted key,
its prefix/suffix, length, character classes, or partial provider error details.
The input field is cleared after every submit attempt.

**Deletion and revocation:** overwrite rotates the encrypted key row and emits an
audit event. Delete/uninstall starts with a single database transaction that marks
the installation revoked, bumps the revocation generation, invalidates outstanding
job leases and fencing tokens, records deletion-started with a timestamp, and
prevents new jobs from being claimed. Only after that transaction commits does the
control plane disable KMS decrypt grants, cancel queued jobs, evict runner/cache
entries, delete provider key rows and review state, and write the deletion-complete
audit event. Outstanding leases are invalidated before revocation is reported as
complete.

Active runners perform a transactional read of installation state, revocation
generation, lease expiry, and fencing token immediately before every external call
(provider or GitHub) and before publication. If generation advanced, the lease
expired, the token mismatches, or decrypt access was revoked, the runner drops any
plaintext key reference and exits without making another call. The worker control
plane also cancels active provider HTTP streams, sends a graceful termination signal
to active runner processes after the revocation transaction commits, and escalates
to a hard kill after a short published deadline; fencing remains authoritative if a
process cannot be reached. A provider request already on the wire cannot be recalled
and may consume quota, reach provider logs, or continue server-side after the local
stream is aborted. The runner must re-check revocation immediately after response
headers/stream termination and before parsing response content. It must re-check
again immediately before the GitHub publication API call, or before each publication
call if output is deferred/batched, and the publication lease/fencing token is
invalidated by revocation. If revocation occurred in flight, the response bytes are
discarded without extraction, summary generation, persistence, or GitHub
publication; provider-side effects from the already-sent request cannot be undone.
There is no true atomicity across the database and an already-started external
GitHub API call, so the last re-check and fencing token are the final defense before
publication. Integration tests must revoke an installation mid-review, during
provider response handling, and immediately before publication, and verify no
post-revocation publication occurs unless the external GitHub call had already
started. Logs keep only redacted operational events. Backups remain encrypted and become
cryptographically unusable once wrapping keys are destroyed; backup copies expire
on the published 30-day retention schedule. GitHub comments/checks already posted
to the user's repo are not deleted automatically because they are user-visible
repository history.

**Rationale:** this preserves the install-once UX while making the custody boundary
explicit and verifiable. Self-hosting remains the sovereignty answer for users who
do not want Prowl to hold encrypted keys at all.

**Rejected alternatives:** environment-only keys for the managed App (not compatible
with install-once UX), plaintext keys in queues or job payloads, a closed-source
hosted service, and asking users for broad personal GitHub tokens.

**Consequences:** the managed instance carries real security/compliance obligations:
KMS operations, deletion jobs, audit access, key-leak tests, and settings UI
authorization are launch blockers rather than implementation details. Even with
those controls, managed v1 does not mitigate determined active-process or
platform-level memory compromise while a key is being decrypted or used; that
residual risk must be documented in launch materials, and stronger live-custody
claims require a native secret helper, sidecar vault, or self-hosted controlled
runtime.

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
  over the proven-complete bounded tree/file cache. Every retrieval endpoint
  validates installation id, repository id, visibility, requested ref, and path
  bounds before making a GitHub request. GitHub code search is disabled for private
  repositories in v1 at the API-client capability boundary, not only at call sites:
  the search helper rejects private-repo requests before building REST/GraphQL
  search calls, and tests assert that no private-repo path can reach GitHub search.
  Search is completely disabled for repositories GitHub reports as private,
  regardless of submodule structure, visibility inheritance, or user configuration.
  Private submodules and cross-repo references are not traversed in managed v1;
  cross-repo context that would require search or broader credentials fails with a
  clear incomplete-context note. Public-repo search results never populate a cache
  entry for a different repository namespace, and every cache key includes
  installation id, repository id, visibility, ref, and retrieval mode. This is
  because code search is a different security boundary than exact-path repository
  reads, especially for private access controls. Public-repo search is disabled by
  default and opt-in only to avoid excessive API load. Future retrieval of GitHub
  Advanced Security findings must not expose secret-scanning or custom-pattern
  findings through code search or any externally indexed surface.
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
  redaction and skip-reporting invariants as local retrieval. The hosted adapter
  uses the shared baseline sensitive-path denylist, including `.env`, `.env.*`,
  `*.env`, `secrets.*`, `credentials.*`, `.npmrc`, `.pypirc`, `.netrc`, SSH/private
  key names such as `id_rsa`, `id_ed25519`, `*.pem`, `*.key`, `*.p12`, and `*.pfx`,
  plus case-insensitive variants. Repository config may add patterns but cannot
  remove the baseline. Provider adapter changes must add canary fixtures for their
  common credential filenames, and retrieval tests fail if a denied path is fetched
  rather than reported as skipped.
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
  HMAC-SHA256 verification using the App-wide webhook secret and constant-time
  comparison. The signature parser accepts only the strict `sha256=<64 hex chars>`
  format with exactly 71 ASCII characters and exactly one signature header; empty
  values, missing prefixes, malformed hex, truncated digests, overlong/padded
  digests, base64-wrapped values, duplicate signature headers, and MD5/SHA1
  signatures are rejected as generic authentication failures before any HMAC
  computation or enqueueing. The malformed-input path does not normalize, truncate,
  compare partial prefixes, or choose first/last duplicate headers. For validly
  formatted signatures, the receiver computes expected digests for every currently
  valid candidate secret selected from server config, performs equal-length
  constant-time comparisons for every candidate regardless of match or mismatch,
  combines the results without per-candidate branching/logging, and rejects the
  entire request only after the full candidate set has been tested. It accepts only
  a matched candidate whose `not_before`/`not_after` window is valid. The required
  implementation pattern is `crypto.timingSafeEqual` or equivalent for each
  candidate, bitwise/result accumulation instead of `some`/early `return`, no
  per-candidate logs until the loop completes, and tests showing equivalent
  behavior when the matching secret is first, last, or absent. Delivery ids are
  recorded with a 24-hour replay TTL before enqueueing, keyed with delivery id,
  payload hash, action, and accepted secret version. Verified webhooks still pass
  through app-wide,
  source-rate, and per-installation token buckets before a job is queued.
  Webhook secrets rotate at least every 90 days or immediately on suspected
  compromise. Because the secret belongs to the GitHub App registration, managed
  provisioning and rotation are operator-only, App-wide flows; installation admins
  may view diagnostics for their installation but cannot rotate or resynchronize the
  shared secret. During planned rotation, the previous secret may verify only
  duplicate redeliveries whose delivery id and payload hash were first accepted
  before the new secret became active; those duplicates are never re-enqueued and
  can only return the existing accepted/duplicate outcome. New delivery ids signed
  with the previous secret are rejected. Replay records for the previous secret
  expire at the earlier of 24 hours from first accepted delivery or the configured
  rotation grace deadline. After the grace window, old-secret deliveries fail closed
  even if GitHub retries them late. Self-host operators own the same App-wide
  rotation flow for their registered App.
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
owner and lifecycle generation: `{installation, repository, pull_request, head_sha,
owner, lifecycle_generation}`, and both delivery paths re-check the owner before
provider calls and publication. This Action/App owner check is a launch blocker for
dual-delivery support.

**Command authorization:** the `@prowl-review` command surface moves to
`issue_comment`/`pull_request_review_comment` webhooks with the same verbs, but
commands are honored only when all checks pass:

1. The comment belongs to a pull request in a repository covered by the active App
   installation.
2. A cheap mention prefilter and token bucket run before GitHub permission APIs:
   30 command authorization attempts per minute and 300 per hour per installation,
   10 per minute per sender, then the existing per-command limit below. The sender
   must have repository `write`, `maintain`, or `admin` permission, verified through
   repository collaborator/permission APIs. A short-lived positive permission cache
   may avoid repeated GitHub calls only when it was minted from GitHub for the same
   `{installation, repository, sender, required_role}` within the last 5 minutes.
   Cache invalidation is atomic with webhook ingestion for permission-changing
   events, including `member` collaborator add/remove/edit, `membership` add/remove,
   `organization` member add/remove/invite/role changes, `team` edit/delete and
   repository add/remove, `team_add`, `repository` visibility/transfer/archive/delete
   changes, `installation_repositories`, and `installation` suspend/delete. Unknown
   membership, team, collaborator, repository-permission, or installation-scope
   events invalidate the whole installation permission cache. Cache hits, misses,
   and invalidations are audited; stale, missing, or lower-role cache entries cannot
   authorize a command. `configure key` is stricter than the general command gate:
   before creating any settings link, the command parser must verify the sender is
   an installation admin, defined as org-owner permission for org installations or
   repository `admin` permission for repo-only/user installations; a writer/maintainer
   cannot receive a key-configuration link. The settings UI repeats the same fresh
   authorization after the link is opened: the OAuth/App session user must match the
   command sender, the installation id and repository id must match the signed link
   record, and GitHub must confirm the same elevated role. If GitHub cannot confirm
   the role at either gate, the command fails closed and is audited.
3. The webhook signature, delivery id, comment id, edited timestamp/body digest,
   installation id, repository id, PR number, and current head SHA match the
   idempotency record for the command. Before any provider call or side effect, the
   handler atomically claims an unconsumed command record keyed by those fields plus
   command verb and lifecycle generation, and marks it consumed in the same
   transaction. Already-consumed records are rejected even when the delivery id,
   comment id, body digest, and head SHA match. Edited comments create a distinct
   consume-once record keyed by edited timestamp and body digest only after a
   comment-level execution lock keyed by `{installation, comment_id, command,
   head_sha, lifecycle_generation}` is available. That lock is held from claim
   through command terminal state, including provider calls and publication, with
   its own lease and fencing token. The handler validates that the current GitHub
   comment timestamp/body digest still matches the claimed delivery immediately
   before side effects; if it advanced, the in-flight command aborts as superseded.
   If an edit arrives while the lock is held, the newer edit is queued behind the
   lock or rejected with a retry-after response, never executed concurrently.
   Delivery-id replay records live for 24 hours, and state-changing/costly commands
   are rate-limited to 5 commands per minute per `{installation, user, pull_request,
   command}` before any provider call. Violations are rejected, audited, and alerted
   on repeated abuse.
4. The command is in the explicit current allowlist: `review`, `full review`,
   `break glass`, `ignore`, `resolve`, per-PR `configure`, `pause`, `resume`,
   `docstrings`, `tests`, `help`, chat replies, and `configure key` link creation.
   No command executes repository code or arbitrary shell, and fork PRs still
   follow Decision 0's managed skip policy.

`configure key` link creation is not sufficient to save a key. The settings link is
cryptographically signed, stored server-side by nonce hash, bound to `{installation,
repository, sender, comment_id, head_sha, nonce}`, expires in 10 minutes, is
single-use, requires fresh GitHub OAuth/App authorization with the
installation-admin definition above, carries no key material in the URL, and uses
standard OAuth state plus an explicit signed CSRF token bound to the nonce and
session before accepting a provider key. The key-save POST must happen over HTTPS
with the same authorized session, and nonce consumption plus key persistence must
commit in one transaction; a second request for the same nonce gets a used/expired
response and cannot write a key.

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

## Decision-record coverage for #62

The backlog gate requires every listed hosted-App decision to have a selected
option, rationale, rejected alternatives, and consequences before #47 is un-parked.
The explicit records are:

| Backlog decision | Selected option | Rationale | Rejected alternatives | Consequences |
| --- | --- | --- | --- | --- |
| Webhook architecture | Thin open-source webhook service using the shared TypeScript core; Cloudflare Workers + Queues is the reference managed receiver/orchestrator. | Durable idempotency, leased claims, stale-head checks, and fork skips keep instant reviews deterministic. | Queueing before durable idempotency, delivery-id-only dedupe, automatic fork review, and waiting for full checkout infrastructure. | Requires persistence before the queue and user-visible duplicate/superseded/skip states. |
| Key custody, secret lifecycle, and least privilege | Open-source self-host path plus managed per-installation envelope encryption with KMS/HSM roles, audited grants, revocation, deletion, and explicit live-runner residual risk. | Preserves install-once UX while making Prowl's managed custody boundary verifiable. | Environment-only managed keys, plaintext queue payloads, closed-source hosting, broad PATs, and claiming Node memory erasure solves live compromise. | KMS policy, leak tests, deletion jobs, revocation fencing, incident response, and settings authorization are launch blockers. |
| Retrieval strategy | Managed v1 uses bounded GitHub API retrieval; sandbox/container checkout is v2; Docker self-host keeps full local parity. | API-first ships install-once reviews without unbounded runtime cost, while incomplete context is surfaced honestly. | Unbounded traversal, treating partial retrieval as complete, user PATs for dependency traversal, and blocking launch on containers. | Managed v1 can produce incomplete reviews and must publish retrieval limits and caveats. |
| Free/paid boundary and abuse controls | CLI, Action, App source, and self-host stay free forever; managed launches free with published orchestration fairness limits. | Protects shared hosted infrastructure without monetizing BYOK inference or gating source/self-host features. | Inference resale, self-host feature gates, silent throttling, and applying hosted limits to local/Action paths. | Requires queue visibility, limit state, retry semantics, and operator dashboards. |
| State, persistence, tenant isolation, audit, and webhook verification | Persist operational metadata only, key every row/message/cache/audit event by installation id, keep append-only audit logs, and strictly verify webhook signatures before enqueueing. | Reliability needs state, but durable systems must not become a code, prompt, or review-content warehouse. | Durable prompts/provider payloads, mutable audit logs, shared runner credentials, and webhook retries without local replay state. | Debugging relies on redacted traces, structured outcomes, and short-lived runtime inspection. |
| Migration from the Action, App identity, delivery precedence, and commands | Reuse the `prowl-review` App identity, select delivery owner through trusted-base `delivery.owner` set to `action` or `app`, and authorize commands through signed webhooks plus GitHub permission checks. | Preserves update-in-place behavior while preventing the Action and App from reviewing the same PR head. | A sibling cloud App, author-agnostic hidden markers, workflow-file-only precedence, and accepting commands from any mention. | Launch requires owner checks in both delivery paths, command replay/rate records, and a settings flow for key configuration. |

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
