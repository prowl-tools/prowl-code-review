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
  lease, refreshes the fencing token for that attempt, and advances a per-job
  counter; runners cannot choose or reuse it. A decrypt broker issues one decrypt
  authorization for that allocated nonce/fencing-token pair, marks it consumed
  before returning plaintext, and rejects stale/replayed nonces or stale fencing
  tokens, including after runner crashes or network retries. Each provider API
  request or retry therefore requires a fresh decrypt authorization and current
  fencing token; the decrypted key is used to construct exactly one outbound
  provider attempt and then cleared in `finally` before any subsequent retry or
  provider call can start. This adds KMS latency/cost but prevents a normal runner
  path from reusing one decrypt across multiple calls; it does not protect against a
  runner already compromised during that authorized call.
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
keys; rotating the root key at least every 90 days re-wraps data keys. Incident
timers start at detection time, defined as the moment an automated control or
operator first classifies a scoped grant, root key, audit stream, or policy state as
suspect; they do not start when revocation processing later succeeds. Suspected
scoped compromise disables affected decrypt grants immediately, blocks new job
claims for affected installations, and alerts operators within 5 minutes. Broad or
critical wrapping-key compromise freezes all affected managed decrypts within 15
minutes. In both cases, the control plane immediately cancels queued work and
terminates active runners with a 30-second hard deadline rather than waiting for the
next decrypt check. Re-wrap/destruction begins immediately, affected installations
stay suspended until it completes, and the 4-hour target is a maximum restoration
objective for scoped events, not a period where compromised grants keep working.
These incident timers are post-detection containment for future decrypts and stored
ciphertext; they do not undo plaintext exposure that occurred before detection or
provider requests already sent by a live compromised runner. Queue messages carry
installation, repo, PR, head SHA, and key row identifiers, never plaintext keys or
encrypted key blobs.

Each encrypted provider-key row is an authenticated envelope, not just ciphertext.
The envelope metadata commits to installation id, key row id, provider name, data
key id, key version, and creation generation, and it stores a KMS/HSM-backed HMAC
tag over that metadata plus the plaintext key bytes. After decrypt, the runner asks
KMS/HSM to verify the non-exportable HMAC tag against the requested envelope
metadata before using the key. A metadata mismatch, tag failure, or unexpected key
row/provider pairing fails closed, revokes the job grant, and emits an audit event;
the runner never sends a provider request with a key whose envelope does not match
the installation being processed.

Plaintext provider keys exist in two managed-service places only: the settings
key-ingestion path while an admin saves or rotates a key, and the runner process
while constructing and sending the direct provider request. Most critically, a
compromised settings process during key save or a compromised runner process while
decrypting/sending the provider request exposes the plaintext key in memory; no
Node/V8 mitigation can prevent that. The managed v1 boundary is therefore not
suitable for users who require protection against live process compromise,
host-level memory disclosure, malicious platform operators, CPU side channels, or a
provider endpoint compromise. Those users should self-host the Docker runner and
settings service on hardware/runtime they control; a native secret helper or
sidecar vault with memory-locking is required before Prowl can claim stronger
live-custody protection for the managed service. The controls below reduce
accidental persistence, ordinary crash dumps, logs, traces, and reuse after a job
exits.

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
authorization data beyond the active request, replay a constructed request object,
or enable request debugging. Provider calls use direct TLS egress from the runner to
the configured provider endpoint: no shared outbound HTTP cache, no CDN, no
transparent proxy, no inherited `HTTP_PROXY`/`HTTPS_PROXY` environment, and no
tenant-shared connection pool that can retain provider headers or bodies. Requests
include `Cache-Control: no-store` and `Pragma: no-cache` where the provider accepts
them, and the client never forwards provider responses through an intermediate cache
before redaction. Each attempt obtains a fresh lease/fencing snapshot, provider-call
nonce, and decrypt authorization tied to the current revocation generation; retries
cannot reuse any of those values. The control plane consumes the provider-call nonce
and grant in the same transaction that authorizes decrypt, with a unique key over
`{installation, job, attempt, nonce}` so a buggy retry loop or attacker cannot
resubmit a failed attempt's nonce. The attempt is wrapped in a
`try/finally` that starts before decrypt and encloses request construction, send,
streaming, and response handling; catch/finally code may reference only local
mutable buffers and sanitized enum state, never generic exception serialization over
objects that may contain the key. If request construction, send, streaming, or
response handling fails, the `finally` block zeroes owned mutable buffers
best-effort and clears all runner references before any retry can begin. The retry
loop lives outside the HTTP client and rebuilds every outbound attempt from a fresh
decrypt after `finally`; automatic client/SDK retries, redirects, and buffered
request replay are disabled. Credentials must stay out of prompts, provider request
bodies, serialized URLs, structured error metadata, and generic exception
inspection.
Provider keys are decoded from the envelope into owned `Buffer`/`Uint8Array`
instances and stay out of long-lived JavaScript strings until the final transport
header boundary. Best-effort zeroing means overwriting every owned mutable key,
header, and canary buffer with `Buffer.fill(0)` or an equivalent native
`sodium_memzero`/secure-zero primitive in `finally`, then dropping references before
the runner exits. If a provider SDK or HTTP primitive forces a transient string copy
for an authorization header, that copy is treated as live-process residual risk and
is allowed only inside the audited minimal client above. Node/V8 cannot guarantee
complete erasure of copied strings, interned values, header normalization buffers,
or HTTP-client internals; per-job process isolation, no long-lived provider clients,
mandatory runner recycling after every job before any other installation's work,
disabled swap/core dumps/heap snapshots/process inspection, startup self-checks for
those controls, and deployment only on platforms where crash-dump controls can be
enforced are mitigations, not a guarantee that memory is clean.

The provider HTTP client is a launch-blocking security component: use a minimal
audited wrapper over Node's `undici`/WHATWG `fetch` streaming primitives, or an
equivalent wrapper only if tests prove the same behavior. The wrapper has no
middleware cache, no automatic redirects, no automatic retries, no request/response
buffering beyond the active socket or one bounded read chunk, no automatic request
object retention, no debug hooks, and no logging of serialized request/response
objects. The launch maximum buffered provider response chunk is 64 KiB before the
runner performs a revocation check and either processes that chunk or discards it;
larger read-ahead or full-body buffering blocks launch. The wrapper must enforce
the chunk limit at the response reader, perform a startup self-test against a
provider mock that attempts over-buffering, and expose a metric/alert if any read
exceeds the bound. Abort signals fire synchronously when revocation is observed and
must destroy active request and response streams plus any owned buffers within a
1-second deadline, then the runner process exits if the stream is still open; no
cached request object may be retried. Tests must include post-attempt canary scans
of available heap/debug artifacts in staging and abort tests proving revocation
fires before full-body buffering on slow, single-chunk, and already-completed
provider responses; a canary present after `finally` completes blocks launch until
the client/wrapper is replaced or patched. A canary may still be observable while
the request is active or inside unavoidable kernel/HTTP-library buffers before abort
is honored; that live-process exposure is the explicit residual risk above.

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
admin. Organization-owner checks require either GitHub App `Members: read`
permission on the installation or an OAuth session with `read:org`; hosted org key
setup fails closed with a reapproval/reauthorization prompt until one of those
membership-reading authorities is available. The settings service stores the latest
observed App permission grant version and dynamically re-checks it before every org
key command and settings save; if the grant is missing or stale, the UI links to the
GitHub App reapproval flow and does not create or consume a key-save nonce unless
OAuth `read:org` can prove owner status for that session. `@prowl-review configure
key` never accepts a raw key in a public comment; it only opens a short-lived,
single-use settings link after the command authorization in Decision 5 succeeds. The
link is an HTTPS-only App URL protected by HSTS, contains
only an opaque CSPRNG nonce with at least 128 bits of entropy whose server-side
record stores a hash, and is redacted from application logs. The signed link record
commits to installation id, repository id, sender id, comment id, head SHA, nonce,
and expiry; the settings UI displays the target owner/repo before save and refuses
cross-origin `Origin`/`Host` mismatches. OAuth `state` and CSRF tokens are signed
values that commit to the nonce hash or link id, authenticated session id hash,
sender id, installation id, repository id, and expiry. The settings page serves no
third-party assets, sends `Referrer-Policy: no-referrer`, `Content-Security-Policy:
form-action 'self'; frame-ancestors 'none'`, and HSTS, uses a dedicated `Secure`,
`HttpOnly`, `SameSite=Strict` key-setup session cookie, and requires the explicit
signed CSRF token on every key-save POST. SameSite cookies are defense-in-depth; the
POST fails unless `Origin`, `Host`, forwarded host/proto, CSRF token, session-binding
hash, and `Sec-Fetch-Site: same-origin` or equivalent browser signal all match the
signed link record and server origin. Rendering the key input requires a
transactional read proving the nonce is unexpired and
unconsumed; the first authorized open binds the nonce row to a hash of the
authenticated session id, sender id, installation id, repository id, link id, row
version, and expiry. The key-save transaction consumes the nonce atomically with an
`UPDATE`/`DELETE` predicate over nonce hash, session-binding hash, sender id,
installation id, repository id, row version, `consumed_at IS NULL`, and unexpired
timestamp, or an equivalent unique constraint, before persisting the key. Concurrent
submissions cannot reuse the link, and a POST from an unbound or different session
cannot create or steal the binding. Later GET/POST requests must present the same
signed session binding and CSRF token. A second session receives the same generic
used/expired response as an already consumed link, while multiple tabs for the same
bound session still rely on the atomic consume-once save transaction. A leaked link
cannot save a key without the fresh GitHub OAuth/App authorization described in
Decision 5. The UI never displays plaintext keys after save.

The key-save endpoint is rate-limited before validation by installation, user
session, and source address. It performs constant-shape local format validation and,
where the provider supports it, a minimal live auth probe over the same sanitized
provider-call path before marking the key verified. If live validation fails or is
unsupported, provider error bodies are not serialized, cached, returned, traced, or
logged; they are mapped to a fixed internal enum such as `invalid`, `unauthorized`,
`rate_limited`, or `unknown`. `invalid` and `unauthorized` results reject the save
and persist no key. `rate_limited` and `unknown` also fail closed by default unless
the provider adapter explicitly declares live validation unsupported; only then may
the endpoint persist an `unverified` key that must be validated through the same
guarded provider-call path before the first review can use it. The endpoint responds
under a fixed wall-clock response budget, with identical HTTP status, headers, and
body bytes for `invalid`, `unauthorized`, `rate_limited`, `unknown`, validation
unsupported, and nonce/session race-loss outcomes. The immediate response never
distinguishes saved, saved-unverified, or not-saved; any later authenticated status
view uses a generic verification-pending/failed state and never includes provider
details. "Identical" means the same status code, same header names/order/values,
same `Content-Length`, same precomputed body bytes, same cookie mutation behavior,
same redirect behavior, and the same externally observable state-machine transition;
the provider enum is stored only in internal audit state after the response budget
has elapsed. The response never re-renders or logs the submitted key, its
prefix/suffix, length, character classes, or partial provider error details. The
input field is cleared after every submit attempt.

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
plaintext key reference and exits without making another call. A stale fencing token
never grants authority: the transactional read must match the current lease token,
revocation generation, and publication token exactly. Provider and GitHub calls are
made only through guarded send functions that perform the transactional check,
allocate/consume any provider-call nonce, attach an abort signal tied to revocation,
and immediately start the external request in the same synchronous operation without
intervening async work. Staging telemetry must measure the final-check-to-HTTP-client
handoff and keep it under a published millisecond-scale budget; exceeding that
budget blocks launch until the guarded sender is redesigned. The
worker control plane also cancels active provider HTTP streams, sends a graceful
termination signal to active runner processes after the revocation transaction
commits, and escalates to a hard kill after a short published deadline; fencing
remains authoritative if a process cannot be reached. A provider request already on
the wire cannot be recalled and may consume quota, reach provider logs, or continue
server-side after the local stream is aborted. A revocation that lands after the
final local check but before the external API receives the request is an unavoidable
cross-system race; the launch docs must disclose it. If revocation is observed while
a provider response is streaming, the abort signal closes the stream immediately,
the runner stops reading further chunks, and all bytes already received are
discarded without parsing. Revocation handling is sequenced as signal, synchronous
abort, buffer discard/zero-owned-buffers best-effort, then process exit if the
stream is still open after the abort deadline. The runner must re-check revocation
after response headers, before and after every bounded response chunk, after stream
termination, and before parsing response content. If a provider or HTTP library has
already buffered up to the 64 KiB chunk limit before the abort is honored, those
bytes are discarded and the event is audited as residual live-buffer exposure; a
client that can buffer more than that limit in process is not launchable. OS/TCP
buffers outside runner memory cannot be zeroed and remain part of the disclosed
live-process/host residual risk. The runner must re-check again immediately before
the GitHub publication API call, or before each publication call if output is
deferred/batched, and the publication lease/fencing token is invalidated by
revocation. If revocation occurred in flight, the response bytes are discarded
without extraction, summary generation, persistence, or GitHub publication;
provider-side effects from the already-sent request cannot be undone. There is no
true atomicity across the database and an already-started external GitHub API call,
so the last re-check and fencing token are the final defense before publication.
Integration tests must revoke an installation mid-review, during active provider
streaming before and after the first chunk, during provider response handling, and
immediately before publication, and verify no post-revocation publication occurs
unless the external GitHub call had already started. Logs keep only redacted
operational events. Backups
remain encrypted and become
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
  withheld, and the output names the missing context. Security findings from
  Gitleaks, dependency scanning, SAST, or equivalent detectors use the same
  completeness state as the review approval. If changed-line content cannot be read
  completely, detectors emit a synthetic **incomplete security context** finding for
  the affected file/range rather than silently dropping the concern; the finding
  states that the changed content was unavailable, approval is withheld, and no clean
  security result is claimed for that scope. If the changed line is available but
  required surrounding, caller, lockfile, dependency, or repository context is
  missing, any emitted security finding must be marked **incomplete context**,
  approval remains withheld, and the output states which verification context was
  unavailable. The hosted App must never publish a clean or fully verified security
  result for a PR whose required security context is incomplete.
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
  separate relevant review/command/control webhook buckets, dead-letter threshold,
  and the existing user-visible
  per-review provider budget guard. They are not product-tier caps on what the
  user's provider key may do, and they do not apply to self-hosted deployments.
- **Launch defaults:** start with 1 active review and 10 queued reviews per
  installation, a 60 relevant command-webhook-events/hour token bucket, a separate
  review-event bucket, lossless authorization-control ingestion for permission and
  installation invalidation events, a 30-minute job timeout, and dead-letter after 3
  consecutive runner failures for the same job. Operators may tune these globally
  during beta, but every change must remain published and audited.
- **Limit behavior:** duplicate webhooks coalesce; irrelevant signed comment noise
  is acknowledged as no-op after replay/idempotency recording and is not charged to
  installation review, command, or authorization-control processing. Review and
  command concurrency excess queues with a `retry_after`/pending status. If review
  queue depth or review-event capacity is exhausted, the receiver durably records a
  coalesced `pending_latest_head` per `{installation, repository, pull_request}`
  instead of dropping the newest delivery; older queued heads stale-close, and the
  latest desired head is enqueued when capacity returns. Abusive review/command
  webhook bursts are rejected before provider calls only after durable latest-head
  coalescing or pre-auth command throttling has preserved legitimate work.
  Authorization-control deliveries are never burst-dropped: if their processing
  capacity is exhausted, the receiver persists and coalesces the latest control
  state, pessimistically bumps the installation auth generation, blocks new job
  claims and decrypts for the affected scope, and schedules reconciliation before
  allowing more provider work. Per-review budget exhaustion ends as **Review
  incomplete** with approval withheld. No limit silently degrades context or pretends
  a review completed.
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
  review state (marker/review ids, posted finding fingerprints, learnings pointers,
  coalesced `pending_latest_head` for overloaded PRs), webhook idempotency records,
  queue/dead-letter metadata, deletion jobs, and audit events.
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
  format with exactly 71 ASCII characters and exactly one `X-Hub-Signature-256`
  header after case-insensitive header-name normalization across the raw header
  list; an absent header is a hard verification failure. The receiver must iterate
  the raw `Headers`/wire header collection and reject multiple values, comma-joined
  values, framework-coalesced duplicates, and case-variant duplicates such as
  `x-hub-signature-256` plus `X-Hub-Signature-256`. Empty values, missing prefixes,
  malformed hex, truncated digests, overlong/padded digests, base64-wrapped values,
  duplicate signature headers, and MD5/SHA1 signatures are rejected as generic
  authentication failures before any HMAC computation or enqueueing. The
  malformed-input path does not normalize, truncate, compare partial prefixes, or
  choose first/last duplicate headers. Webhook secrets are generated
  and loaded as 32-byte random byte arrays, not variable-length strings. The receiver
  always builds a fixed two-slot candidate array: current secret and
  previous-secret-or-32-byte-dummy, with version/window metadata masked into the
  final decision after comparison. For validly formatted signatures, the receiver
  computes expected digests for every candidate slot before any replay store lookup,
  performs equal-length constant-time comparisons for every slot regardless of match
  or mismatch, combines match bits with bitwise OR/result masking in a full-length
  loop, and rejects the entire request only after the full candidate set has been
  tested. It accepts only a matched candidate whose `not_before`/`not_after` window
  is valid. The required implementation pattern is `crypto.timingSafeEqual` or
  equivalent for each candidate, fixed-count loop iteration, no `some`/early
  `return`, no per-candidate exceptions, no per-candidate internal state in logs or
  traces until the loop completes, and tests showing equivalent behavior when the
  matching secret is first, last, dummy/absent, or outside its validity window. Only
  after the full signature loop completes does the receiver consult the replay
  store. Delivery ids are recorded with a 24-hour replay
  TTL before enqueueing, keyed with delivery id, payload hash, action, and accepted
  secret version. New replay rows may be inserted only for the current secret version
  or for the first accepted delivery before `new_secret_active_at`; an old-secret
  match during grace is never allowed to create the prior replay record it needs for
  acceptance. After signature and replay handling, the receiver performs cheap
  relevance classification before charging per-installation buckets: non-PR events,
  comments without an `@prowl-review` mention/command, and other no-op signed noise
  are acknowledged without consuming review, command, or authorization-control
  quota. Relevant review and command deliveries use separate per-installation buckets
  so public comment noise cannot starve review starts. Permission and
  installation-control deliveries are persisted into a durable coalescing control
  log before processing limits are applied; if processing is saturated, the system
  fails closed by bumping auth generation, cancelling affected leases, blocking new
  decrypts/job claims, and reconciling installation/repository/permission state from
  GitHub before reopening the scope. App-wide and source-rate abuse buckets still
  apply before a review or command job is queued, but they cannot drop signed
  suspend/delete, installation-repository, or permission-invalidation control events.
  Webhook secrets rotate at least every 90 days or immediately on suspected
  compromise. Because the secret belongs to the GitHub App registration, managed
  provisioning and rotation are operator-only, App-wide flows; installation admins
  may view diagnostics for their installation but cannot rotate or resynchronize the
  shared secret. During planned rotation, the previous secret remains in the
  candidate set for a fixed 10-minute grace window from `new_secret_active_at`; the
  window may be shortened to zero but not lengthened per delivery. Suspected
  compromise uses zero grace and fails closed immediately. Within the planned grace
  window, the previous secret may verify only duplicate redeliveries whose delivery
  id and payload hash were first accepted before the new secret became active; those
  duplicates are never re-enqueued and can only return the existing
  accepted/duplicate outcome. New delivery ids signed with the previous secret are
  rejected even if the HMAC matches. Old-secret HMAC is computed before the replay
  store check, but a match is necessary only for the later duplicate decision: the
  receiver must find an existing immutable replay record with matching delivery id,
  payload hash, action, and old accepted secret version whose `first_seen_at <
  new_secret_active_at` before accepting the request as a duplicate. If that prior
  record is missing or violates the timestamp/version invariant, the request is
  rejected and no new old-secret replay row is inserted. Replay records for the
  previous secret expire at the earlier of 24 hours from first accepted delivery or
  the 10-minute rotation grace deadline. After the grace window, the old secret is
  removed from the candidate set and old-secret deliveries fail closed even if GitHub
  retries them late. Tests must cover old-secret new delivery rejection during grace,
  old-secret duplicate acceptance only with a pre-activation replay row, and
  old-secret rejection after grace despite a matching HMAC. Self-host operators own
  the same App-wide rotation flow for their registered App.
- **Abuse controls:** per-installation queue depth/concurrency, separate relevant
  review/command buckets after no-op filtering, lossless durable control-event
  coalescing with fail-closed reconciliation, dead-letter + alerting on repeated
  failures, and stale-head close-out so a misbehaving repo cannot spin the queue,
  starve authorization invalidation, or publish outdated reviews.

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

Before the first external managed hosted installation, every private key for the
reused `prowl-review` App that was distributed to repository or organization Action
secrets such as `PROWL_APP_PRIVATE_KEY` must be revoked at the GitHub App level and
rotated. Deleting repository secrets is not sufficient; the old App private-key
versions must be removed from the GitHub App registration so a copied key can no
longer mint installation tokens anywhere. The managed installer and token-minter
have a hard runtime launch gate, implemented as startup and per-request policy code
rather than a checklist: external installation acceptance, token minting, and review
enqueueing remain disabled until the policy store contains a two-operator-signed
credential-rotation record. That record must name the revoked GitHub App key
versions, include CI evidence from the GitHub App credential audit/export, name the
replacement managed key version generated after the cutoff, and include a production
canary showing a retired key cannot mint an installation token. The canary runs in
production before opening external installs and as a scheduled drift check; failure
after launch immediately disables external installation acceptance, hosted token
minting, and review enqueueing for the managed App until operators either repair the
revocation evidence or migrate to a new App identity. If GitHub-level revocation
cannot be verified with high confidence, the managed service must register and
provision a new GitHub App identity whose private key was never distributed to
Actions; migration docs then map old Action markers to the new bot only through the
explicit marker-copy job above. The managed App signing credential lives only in the
managed secret store, HSM, or token broker used by the hosted token-minter; it is
never stored in this repository, workflow secrets, Action logs, or customer
repositories. The Action path must use `GITHUB_TOKEN`, a user-owned GitHub App
credential scoped to that operator, or a brokered token that can mint only for the
current repository/workflow and cannot mint across managed hosted tenants. Sharing
the managed App signing credential with Actions is a launch blocker.

Uninstalling the `prowl-review` App immediately disables hosted reviews and token
minting for Action workflows that depend on that App. Existing Action workflows
fall back to `GITHUB_TOKEN` only when they are written with the current tolerant
token-minting path; otherwise they fail visibly until the App is reinstalled or the
workflow is reconfigured.

**Delivery ownership:** the shared authority is GitHub-backed, not a private hosted
database row: the trusted-base `.prowl-review.yml` gains `delivery.owner: action |
app`. The hosted installation store may cache the last observed owner for the UI for
at most 5 minutes, but it cannot override the trusted-base config and is never used
as runner authority. If the trusted-base config cannot be read, cannot be parsed, or
comes from an untrusted ref, the App fails closed as "unclear delivery owner" and
does not fall through to workflow detection. If `delivery.owner` is absent, setup
uses workflow-file detection only as a bootstrap aid: repositories with both Action
workflows and the hosted App must set the field explicitly, and the App yields with
an explanatory "delivery owner not configured" status rather than guessing. The App
owns by fallback only when a fresh trusted-base read proves the owner field is absent
and no Action or reusable Action workflow is present for that PR head. Workflow file
detection cannot override an explicit config owner and is re-run from the trusted
base before claim; repos that want hosted failover must set an explicit owner in
trusted-base config rather than relying on broken-workflow detection.

Before hosted launch, the Action must learn this field from the same trusted-base
config it already loads and exit with a neutral "App owns delivery" result before
any provider call when `delivery.owner: app`. The hosted App performs the symmetric
check and no-ops when `delivery.owner: action`. Owner is read from the trusted base
ref/config generation associated with the PR head. Owner changes apply to the next
PR head SHA or base-config generation; they increment lifecycle generation and
supersede in-flight work for older generations. Subsequent deliveries for existing
PR heads re-query the owner before enqueueing; in-flight reviews under the previous
owner are marked superseded and stopped before provider calls and before
publication if ownership changed. The runner also re-reads the trusted-base config
immediately before claiming a job, before provider calls, and before publication;
cache expiry or mismatch produces the same unclear-owner skip. The cached owner in
the hosted store is only a UI hint. The idempotency key includes the owner and lifecycle generation:
`{installation, repository, pull_request, head_sha, owner, lifecycle_generation}`,
and both delivery paths re-check the owner before provider calls and publication.
This Action/App owner check is a launch blocker for dual-delivery support.

**Command authorization:** the `@prowl-review` command surface moves to
`issue_comment`/`pull_request_review_comment` webhooks with the same verbs, but
commands are honored only when all checks pass:

1. The comment belongs to a pull request in a repository covered by the active App
   installation.
2. A cheap mention prefilter and token bucket run before GitHub permission APIs:
   30 command authorization attempts per minute and 300 per hour per installation,
   10 per minute per sender, then the existing per-command limit below. These
   pre-auth buckets are separate from the authorized-command quota and are charged to
   untrusted ingress only; they cannot exhaust reserved authorized capacity for
   maintainers. The sender must have repository `write`, `maintain`, or `admin`
   permission, verified through repository collaborator/permission APIs. The shared
   authorized-command quota is charged only after permission is confirmed; denied or
   unauthenticated mentions are audited and rate-limited through the untrusted
   ingress buckets, not through the authorized command budget. A short-lived positive
   permission cache may avoid repeated GitHub calls for non-provider,
   non-state-changing commands only
   when it was minted from GitHub for the same `{installation, repository, sender,
   required_role}` within the last 60 seconds.
   Cache invalidation is atomic with webhook ingestion for permission-changing
   events, including `member` collaborator add/remove/edit, `membership` add/remove,
   `organization` member add/remove/invite/role/rename changes, `team`
   edit/delete/repository add/remove, `team_add`, `repository`
   visibility/transfer/archive/delete changes, `installation_repositories`, and
   `installation` created/deleted/suspend/unsuspend/new-permissions-accepted events.
   Unknown membership, team, collaborator, repository-permission, organization,
   enterprise-policy, branch-protection, or installation-scope events invalidate the
   whole installation permission cache and bump an installation auth generation.
   Because some permission-affecting changes, including branch protection and
   enterprise SAML/IP policy changes, may not arrive as reliable App webhooks, the
   cache is never final authority for commands whose required role depends on those
   policies; those commands must perform a fresh GitHub API read. Settings UI and
   admin command flows expose a cache-bust operation that bumps the installation auth
   generation after permission changes. Cache hits, misses, and invalidations are
   audited; stale, missing, or lower-role cache entries cannot authorize a command.
   The command claim transaction runs under serializable isolation or an equivalent
   compare-and-swap over the installation auth row. It reads the current auth
   generation inside the transaction, requires any prefetched cache generation to
   equal that row, and writes the claimed command with the row version it actually
   locked. If a permission-change webhook lands after the prefilter but before
   claim, the generation bump wins or forces the claim transaction to retry/fail
   before any command record can be consumed. Claimed command records store the auth
   generation used for authorization, and the handler re-checks that generation plus
   performs the fresh GitHub permission API check immediately before side effects; a
   stale generation alone can never authorize execution. If a permission-change
   webhook invalidated the cache mid-command, the command is marked
   `authorization_changed`, no provider/GitHub side effect runs, and the user-visible
   response asks the sender to re-run the command after permissions settle. There is
   no automatic retry for provider-backed, state-changing, or privileged commands
   after authorization invalidation because retrying could execute after a role
   downgrade without explicit user intent. State-changing, privileged, or
   provider-backed commands,
   including `review`, `full review`, `docstrings`, `tests`, chat replies,
   `break glass`, `ignore`, `resolve`, `pause`, `resume`, per-PR `configure`, and
   `configure key`, must perform a fresh GitHub permission API check after the
   command is claimed and immediately before side effects or provider calls; the
   positive cache is only a prefilter for those commands, not final authority. This
   fresh check bypasses the positive permission cache and reads GitHub permission
   APIs directly under the current installation auth generation. `configure key` is
   stricter than the general
   command gate: before creating any settings link, the command parser must verify
   the sender is an installation admin, defined as org-owner permission for org
   installations, repository `admin` permission for repo-only/user installations, or
   membership in the audited installation-admin allowlist maintained by those
   admins. For org installations, that org-owner check requires a dynamic App
   `Members: read` installation-permission check against the current grant version or
   OAuth `read:org` for the authenticated session; a one-time reapproval is never
   assumed to persist without re-checking the current installation permissions. If
   the reused App installation has not been reapproved with membership access and the
   session lacks `read:org`, org key configuration fails closed with a GitHub
   reapproval/reauthorization link and does not create a settings nonce. A
   writer/maintainer who lacks that elevated role cannot receive a key-configuration
   link. The settings UI repeats the same fresh authorization after the link is
   opened: the OAuth/App session user must match the command sender, the installation
   id and repository id must match the signed link record, and GitHub/allowlist state
   must confirm the same elevated role using the same current membership-reading
   authority. If the elevated role cannot be confirmed at either gate, the command
   fails closed, any opened nonce is invalidated so later privilege regain requires a
   new command, and the failure is audited.
3. The webhook signature, delivery id, comment id, edited timestamp/body digest,
   installation id, repository id, PR number, and current head SHA match the
   idempotency record for the command. Before any provider call or side effect, the
   handler atomically claims an unconsumed command record keyed by those fields plus
   command verb and lifecycle generation, and marks it consumed in the same
   transaction. Already-consumed records are rejected even when the delivery id,
   comment id, body digest, and head SHA match. The edited timestamp is GitHub's
   `updated_at` value from a fresh GitHub API read, not a client-derived or
   webhook-trusted clock value, and the body digest covers the full normalized
   comment body plus command parse version and verb, not only the matched command
   fragment. Edited comments create a distinct consume-once record keyed by that
   API-read timestamp and digest only after a comment-level execution lock keyed by
   `{installation, repository, pull_request, comment_id, command}` is available. The
   lock intentionally excludes mutable PR head SHA and lifecycle generation so
   comment edits and head changes serialize behind the same command identity. That
   lock is held from claim through command terminal state, including provider calls
   and publication, with its own lease and fencing token. The handler fetches the
   current GitHub comment again and validates that its `updated_at` value/body
   digest still matches the claimed delivery immediately before side effects; if it
   advanced, the in-flight command aborts as superseded and records the current
   version for later processing. If an edit arrives while the lock is held, the
   newer edit is durably queued behind the lock and re-authorized after the current
   command reaches terminal state; it is not dropped through a Retry-After-only
   webhook response because GitHub will not redeliver it automatically. Delivery-id
   replay records live for 24 hours, and state-changing/costly commands are
   rate-limited to 5 commands per minute per `{installation, user, pull_request,
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
installation-admin definition above, and carries no key material in the URL. OAuth
state and the explicit signed CSRF token must commit to the nonce hash/link id,
session id hash, sender id, installation id, repository id, row version, and expiry
before accepting a provider key. The first authorized settings GET transactionally
binds the nonce row to that session before rendering the key input, and the key-save
POST must happen over HTTPS with the same authorized session. Nonce consumption plus
key persistence must commit in one transaction using a predicate that includes the
nonce hash, session-binding hash, sender id, installation id, repository id, row
version, unexpired timestamp, and `consumed_at IS NULL`; a second request or
different session for the same nonce gets a generic used/expired response and
cannot write a key.

**Rationale:** reusing the bot identity preserves update-in-place behavior for
current `prowl-review[bot]` summaries, while shared delivery-owner config prevents
both the Action and App from starting reviews for the same PR head.

**Rejected alternatives:** registering a sibling cloud App with a different bot
login when GitHub-level key revocation can be verified, treating hidden markers as
delivery-agnostic regardless of author, deciding delivery precedence from stale
workflow-file detection, sharing managed signing credentials with Actions, and
accepting commands from any commenter with a syntactically valid mention.

**Consequences:** hosted launch requires verified GitHub-level revocation of
Action-distributed App keys or a new App identity, delivery-owner config/cache
support with fail-closed trusted-base reads, owner checks in both delivery paths,
command replay records, and an installation-admin settings flow before command
parity is considered complete.

## Decision-record coverage for #62

The backlog gate requires every listed hosted-App decision to have a selected
option, rationale, rejected alternatives, and consequences before #47 is un-parked.
The explicit records are:

| Backlog decision | Selected option | Rationale | Rejected alternatives | Consequences |
| --- | --- | --- | --- | --- |
| Webhook architecture | Thin open-source webhook service using the shared TypeScript core; Cloudflare Workers + Queues is the reference managed receiver/orchestrator. | Durable idempotency, leased claims, stale-head checks, and fork skips keep instant reviews deterministic. | Queueing before durable idempotency, delivery-id-only dedupe, automatic fork review, and waiting for full checkout infrastructure. | Requires persistence before the queue and user-visible duplicate/superseded/skip states. |
| Key custody, secret lifecycle, and least privilege | Open-source self-host path plus managed per-installation envelope encryption with KMS/HSM roles, audited grants, revocation, deletion, and explicit live-runner residual risk. | Preserves install-once UX while making Prowl's managed custody boundary verifiable. | Environment-only managed keys, plaintext queue payloads, closed-source hosting, broad PATs, and claiming Node memory erasure solves live compromise. | KMS policy, leak tests, deletion jobs, revocation fencing, incident response, and settings authorization are launch blockers. |
| Retrieval strategy | Managed v1 uses bounded GitHub API retrieval; sandbox/container checkout is v2; Docker self-host keeps full local parity. | API-first ships install-once reviews without unbounded runtime cost, while incomplete context is surfaced honestly. | Unbounded traversal, treating partial retrieval as complete, user PATs for dependency traversal, and blocking launch on containers. | Managed v1 can produce incomplete reviews, must publish retrieval limits and caveats, and must label or withhold security findings when required context is incomplete. |
| Free/paid boundary and abuse controls | CLI, Action, App source, and self-host stay free forever; managed launches free with published orchestration fairness limits, separate relevant review/command buckets, and lossless control-event reconciliation. | Protects shared hosted infrastructure without monetizing BYOK inference or gating source/self-host features. | Inference resale, self-host feature gates, silent throttling, charging no-op comment noise to tenant review/control buckets, dropping authorization-control webhooks under burst load, and applying hosted limits to local/Action paths. | Requires queue visibility, limit state, retry semantics, durable control-event coalescing, and operator dashboards. |
| State, persistence, tenant isolation, audit, and webhook verification | Persist operational metadata only, key every row/message/cache/audit event by installation id, keep append-only audit logs, and strictly verify webhook signatures before enqueueing with fixed 10-minute planned rotation grace. | Reliability needs state, but durable systems must not become a code, prompt, or review-content warehouse. | Durable prompts/provider payloads, mutable audit logs, shared runner credentials, and webhook retries without local replay state. | Debugging relies on redacted traces, structured outcomes, short-lived runtime inspection, explicit rotation replay tests, and bounded streaming-abort tests. |
| Migration from the Action, App identity, delivery precedence, and commands | Reuse the `prowl-review` App identity only after Action-distributed App private keys are revoked at the GitHub App level and verified, select delivery owner through trusted-base `delivery.owner` set to `action` or `app`, and authorize commands through signed webhooks plus fresh GitHub permission checks. | Preserves update-in-place behavior while preventing the Action and App from reviewing the same PR head or sharing a cross-tenant signing key. | A sibling cloud App unless key revocation cannot be verified, author-agnostic hidden markers, workflow-file-only precedence, sharing the managed App private key with Actions, and accepting commands from any mention. | Launch requires owner checks in both delivery paths, command replay/rate records, managed signing-key isolation, verified credential-rotation gate, and a settings flow for key configuration. |

## Build plan (when approved)

1. Receiver + queue + installation store + persistent idempotency, using the
   existing `prowl-review` App identity for the managed instance only after every
   Action-distributed private key for that App is revoked at the GitHub App level,
   a canary proves retired keys cannot mint installation tokens, and the managed
   signing credential is isolated outside repository/workflow secrets. If that
   verification cannot complete, register a new managed App identity before launch.
2. Trusted-base `delivery.owner` config plus fail-closed Action/App owner checks so
   dual delivery cannot start duplicate reviews when config is missing, stale, or
   unreadable.
3. Managed key settings UI, envelope encryption, KMS access controls, audit log,
   org-membership permission/reapproval for org key setup, and deletion lifecycle.
4. API-retrieval adapter for the core's repo-tools interface with the Decision 2
   bounds and incomplete-review states.
5. Runner + posting path (core unchanged) + command authorization/replay handling.
6. Self-host packaging (Workers deploy button + Dockerfile) and SECURITY.md/docs.
7. Beta on our own repos → publish policy docs/limit defaults → announce.

Each step lands as its own backlog item once #47 is un-parked; this doc's approval
is the gate.
