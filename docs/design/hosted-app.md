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
host-level memory disclosure, malicious platform operators, malicious runtime
dependencies in the settings/runner path, CPU side channels, or a provider endpoint
compromise. Post-detection containment and revocation reduce only future exposure;
they cannot undo plaintext disclosure that occurred before detection. The managed
service is therefore incompatible with a zero-trust-of-Prowl-infrastructure threat
model. Those users should self-host the Docker runner and settings service on
hardware/runtime they control; a native secret helper or sidecar vault with
memory-locking is required before Prowl can claim stronger live-custody protection
for the managed service. The controls below reduce accidental persistence, ordinary
crash dumps, logs, traces, and reuse after a job exits.

For managed v1 launch, the settings key-ingestion path is not a long-lived web
process once plaintext key bytes are present. Each save/rotation runs in a hardened
short-lived worker with the same no-debug, no-core-dump, no-swap, blocked
inspection/heap-snapshot, sanitized logging, and mandatory post-request recycle
requirements as the runner. Submitted key bytes are copied out of framework request
objects into native secure allocation with memory locking and explicit zeroing
(`sodium_malloc`/`sodium_memzero` or platform equivalent) before validation and
envelope encryption; if the managed platform cannot provide that primitive for key
ingestion, launch is blocked until an external secret helper or sidecar vault owns
the ingestion step. The native primitive is not provided by the general Node request
handler: it must be implemented by a pinned, audited N-API/libsodium binding inside
the short-lived ingestion worker or by a separate local secret broker that receives
the key over local authenticated IPC and returns only the encrypted envelope. These
controls reduce persistence after save, but they still do not protect against
malicious code or an operator already executing inside that worker during the live
save window.

Managed launch materials must surface that boundary before the user installs the App
or enters a provider key. The install page, migration guide, and first key-setup
screen must state that managed hosting is weaker than CLI/Action for live key
custody because plaintext keys exist briefly in Prowl-controlled workers; key entry
requires an explicit acknowledgement, while CLI, Action, and self-host remain the
recommended paths for users who reject that boundary.

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
is allowed only inside the audited minimal client above. Buffer zeroing is hygiene,
not cryptographic erasure and not the primary defense against process compromise.
Node/V8 cannot guarantee complete erasure of copied strings, interned values, CPU
caches, header normalization buffers, kernel buffers, or HTTP-client internals;
per-job process isolation, no long-lived provider clients, mandatory runner
recycling after every job before any other installation's work, disabled swap/core
dumps/heap snapshots/process inspection, startup self-checks for those controls, and
deployment only on platforms where crash-dump controls can be enforced are
mitigations, not a guarantee that memory is clean.

The provider HTTP client is a launch-blocking security component: use a minimal
audited wrapper over Node's `undici`/WHATWG `fetch` streaming primitives, or an
equivalent wrapper only if tests prove the same behavior. The wrapper has no
middleware cache, no automatic redirects, no automatic retries, no request/response
buffering beyond the active socket or one bounded read chunk, no automatic request
object retention, no debug hooks, and no logging of serialized request/response
objects. Its runtime dependency set is explicitly allowlisted, pinned by the
production lockfile, included in the SBOM, and reviewed in the launch-blocking
dependency audit; dependency updates that can observe headers, sockets, streams,
environment, or errors require security review before deployment. The wrapper does
not load provider SDK plugins, middleware, proxy agents, or instrumentation by
tenant configuration. A malicious dependency that reaches the runner despite those
controls is treated as live-process compromise and remains unmitigated for the active
request window. An equivalent wrapper cannot be approved by happy-path tests alone:
launch tests must exercise 301/302/307/308 redirects, retryable 429/500 responses,
socket reset, DNS failure, proxy environment variables, oversized response chunks,
slow streaming, debug/error serialization, keep-alive reuse across tenants, and
attempted middleware/plugin injection. The passing criteria are one outbound network
attempt per provider-call nonce, no redirect follow, no automatic retry, no inherited
proxy use, no retained `Authorization` header after `finally`, no serialized
request/response object containing credentials, no cross-tenant connection reuse, and
enforced abort/buffer limits. Approval requires the test report plus security-owner
sign-off by a two-person security quorum whose members did not author the wrapper and
are not the deployment approver. The wrapper reruns the equivalence suite at startup,
after dependency updates, and at least daily as a drift check; failure disables hosted
provider calls and pages on-call until the wrapper or dependency set is repaired. The
managed App has no approved provider HTTP wrapper until the repository contains a
named reference implementation, canonical provider mock, equivalence test harness,
dependency provenance report, and signed launch record for that implementation; using
an unnamed "equivalent" wrapper is itself a launch blocker. The reference harness is
the only source of accepted alternatives, and each alternative must pass the same
fixtures before it can be enabled. The
launch maximum buffered provider response chunk is 64 KiB before the runner performs
a revocation check and either processes that chunk or discards it;
larger read-ahead or full-body buffering blocks launch. The wrapper must enforce
the chunk limit at the response reader: if a read would exceed 64 KiB, the wrapper
aborts the provider request, zeroes/discards the partial chunk, marks the provider
attempt incomplete with no retry of that request object, and recycles the runner.
Continuing to parse or summarize an over-limit chunk is launch-blocking. The wrapper
must perform a startup self-test against a provider mock that attempts over-buffering
and expose a metric/alert if any read exceeds the bound. Abort signals fire
synchronously when revocation is observed and
must destroy active request and response streams plus any owned buffers within a
1-second deadline, then the runner process exits if the stream is still open; no
cached request object may be retried. Tests must include post-attempt canary scans
of owned buffers, structured logs, traces, serialized errors, and available
heap/debug artifacts in staging after the wrapper has run `finally`, dropped
references, forced an explicit GC where the runtime permits, and recycled the worker.
A full canary token, authorization header, or configured contiguous canary fragment in
those owned artifacts blocks launch until the client/wrapper is replaced or patched.
Abort tests must prove revocation fires before full-body buffering on slow,
single-chunk, and already-completed provider responses. A canary may still be
observable while the request is active or inside unavoidable kernel/HTTP-library
buffers before abort is honored; that live-process exposure is the explicit residual
risk above.

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
observed App permission grant version, computed from GitHub's current installation
record and permission map, not from an internal remembered approval flag. Before
every org key command and settings save, the handler reads the current installation
permissions from GitHub, requires `Members: read` for the same installation id, and
updates the stored grant version only from that GitHub response. A 403/404, missing
permission, lower permission value, changed installation id, or read failure fails
closed as stale and links to GitHub App reapproval. The OAuth `read:org` path
performs the owner check with the current OAuth session token for that same request;
no cached App grant can substitute for it. If neither current membership-reading
authority is available, the command/UI does not create or consume a key-save nonce.
The command handler performs this fresh installation-admin check synchronously inside
the guarded command/link-creation path immediately before creating a settings link;
if the auth generation changes between the command authorization check and nonce
creation, the link transaction aborts and no key material can be handled. The settings
GET and POST repeat the same current-admin check before rendering the key input or
accepting key bytes.
`@prowl-review configure key` never accepts a raw key in a public comment; it only
opens a short-lived, single-use settings link after the command authorization in
Decision 5 succeeds. The settings hostname must be HTTPS-only at the network
boundary: the load balancer/reverse proxy rejects cleartext HTTP before application
code, nonce lookup, cookies, OAuth state, or CSRF validation can run, and it must not
redirect an HTTP request while preserving the path or query. The settings domain is
HSTS preloaded, or launch remains blocked until the preload submission is accepted
for the exact host or parent domain that covers it. The link is an App URL on that
preloaded HTTPS origin and contains only an opaque nonce
generated with `crypto.randomBytes`, WebCrypto `getRandomValues`, or an equivalent
OS-backed CSPRNG. The nonce has at least 128 bits of entropy, is never derived from
session/user/comment ids, has only a server-side hash persisted, and is redacted from
application logs. Issuance is rate-limited and capped to one active unexpired
key-setup nonce per `{installation, repository, sender, comment_id}` plus a small
per-sender rolling limit; exceeding either cap denies a new link and audits the
attempt rather than creating many concurrent unexpired nonces. The signed link record
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
`rate_limited`, or `unknown`. `invalid`, `unauthorized`, `rate_limited`, `unknown`,
and validation-unsupported results never replace an existing verified key and never
promote a key for reviews. They either persist no key material or store only an
encrypted pending-validation candidate that is not part of the active provider-key
table, is invisible to runners, and is eligible only for a bounded post-response
validation job. Providers without a supported bounded pre-use validation path are not
launchable in managed v1. The endpoint responds under a fixed wall-clock response
budget, with identical HTTP status, headers, and body bytes for `invalid`,
`unauthorized`, `rate_limited`, `unknown`, validation unsupported, skipped
synchronous validation, and nonce/session race-loss outcomes. The immediate response
never distinguishes saved, validation-pending, or not-saved; any later authenticated
status view uses a generic verification-pending/failed state and never includes
provider details. "Identical" means the same status code, same header
names/order/values,
same `Content-Length`, same precomputed body bytes, same cookie mutation behavior,
same redirect behavior, and the same externally observable state-machine transition;
the provider enum is stored only in internal audit state after the response budget
has elapsed. The handler computes a per-request millisecond deadline before any
branch-specific work starts and never releases the response until that deadline is
reached; early-finishing branches sleep to the deadline, and over-deadline branches
return the same generic envelope, alert, and do not persist a verified key. Failure
branches run the same local nonce/session/CSRF/Origin checks, provider-adapter
selection, key-hash/HMAC comparisons, and dummy validation path with conditional
assignments instead of early returns; unauthorized or expired-nonce requests use
dummy credentials and never contact the real provider. Authorized live probes either
finish behind the same response deadline or leave only an inactive pending-validation
candidate for later guarded validation. The last verified key remains active until a
new candidate validates; if no verified key exists, reviews remain disabled because
there is no usable key, not because an `unverified` row replaced authority. Staging
timing tests must issue repeated
`invalid`, `unauthorized`, `rate_limited`, `unknown`, validation-unsupported, expired
nonce, and session-race requests and block launch if p95/p99 distributions diverge
beyond the published bound. The managed v1 launch bound is p95 delta <= 25 ms and
p99 delta <= 50 ms between any two failure classes over at least 10,000 staging
samples per class, after warmup, measured from ingress accept at the load balancer to
the last response byte written, including framework parsing, nonce/session/CSRF/OAuth
checks, database/KMS calls used by that path, and any synchronous validation work. If
including a live provider auth probe would exceed the bound, the endpoint must skip
that synchronous provider call, return the same generic pending envelope, and enqueue
or refresh only a pending-validation candidate after the local constant-shape checks
pass. That candidate has per-installation, per-sender, and per-source creation and
retry limits stricter than the command-ingress buckets; repeated pending candidates
coalesce by installation/provider and cannot make an existing verified key unusable.
The background validator uses the same guarded provider-call path, never starts while
another validation for that installation/provider is active, destroys failed or
superseded candidates, and promotes exactly one candidate to the active verified-key
table only after successful validation in a serializable compare-and-swap
transaction. Probe selection is a provider/adapter deployment setting, not a per-key,
per-format, or per-request branch, and both the live-probe-enabled and no-live-probe
paths release responses only at the same configured deadline with the same dummy
validation work when no provider call is made. If either the no-live-probe path or the
later guarded validation cannot meet its own published bound, launch is blocked. The
residual timing threat
model is statistical leakage of a generic save-state transition under runtime/network
jitter after that bound, never plaintext key material, provider error detail, key
prefix/length/class, or authorization reason.
Production records p50/p95/p99/max latency histograms by internal outcome class only
after the response is committed, never in user-visible output. If any class pair
exceeds the published p95/p99 delta for three consecutive five-minute windows, the
settings service disables synchronous live validation, accepts only inactive
pending-validation candidates behind the generic pending envelope, pages on-call, and
allows runners to use only the last successfully verified key. Installations with no
verified key receive no reviews until validation drift is repaired or launch is rolled
back.
The response never re-renders or logs the submitted key, its prefix/suffix, length,
character classes, or partial provider error details. The input field is cleared
after every submit attempt.

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
and immediately start the external request in the same guarded function without
unrelated awaits or queue hops. Staging telemetry must measure the
final-check-to-HTTP-client handoff, publish p95/p99/max values, and block launch only
if the path is unbounded, contains avoidable async gaps, or regresses beyond the
published SLO for the chosen runtime; it is not a promise of atomic or
microsecond-scale cancellation in Node.js. The
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
  page ceiling. Exact-path reads must preflight the requested path through the trusted
  Git tree for the pinned ref before any GitHub Contents API request can run. The
  adapter rejects symlinks, submodules, mode/type mismatches, and tree entries whose
  target path would violate the sensitive-path denylist; accepted reads fetch the blob
  by the verified tree-entry SHA or prove the Contents response type and SHA match
  that preflight before bytes enter the retrieval cache. Every page, retry attempt,
  response byte, and retrieved byte counts against the request, response-size, and
  timeout ceilings below. The adapter treats Git tree `truncated` responses,
  incomplete PR-file pagination, and missing required blobs as completeness failures.
  Grep/find-reference behavior runs only over the proven-complete bounded tree/file
  cache. Every retrieval endpoint validates installation id, repository id,
  visibility, requested ref, and path bounds before making a GitHub request. GitHub
  code search is disabled for private
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
  required surrounding, caller, manifest, lockfile, package index, private
  dependency, submodule, or repository context is missing, any emitted security
  finding must be marked **incomplete context**, approval remains withheld, and the
  output states which verification context was unavailable. A changed lockfile whose
  package metadata or private dependency cannot be resolved produces an incomplete
  dependency-security finding rather than a clean dependency result. The hosted App
  must never publish a clean or fully verified security result for a PR whose
  required security context is incomplete.
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
  comparison. Verification runs in the raw HTTP adapter before framework header
  normalization; a runtime that cannot expose the original header list with
  duplicate values and case variants is not eligible for launch. The signature parser
  accepts only the strict `sha256=<64 hex chars>` format with exactly 71 ASCII
  characters and exactly one `X-Hub-Signature-256` header after case-insensitive
  counting across the raw header list; an absent header is a hard verification
  failure. The receiver must iterate the raw wire header collection and reject
  multiple values, comma-joined values, framework-coalesced duplicates, and
  case-variant duplicates such as `x-hub-signature-256` plus
  `X-Hub-Signature-256`. Empty values, missing prefixes, malformed hex, truncated
  digests, overlong/padded digests, base64-wrapped values, duplicate signature
  headers, and MD5/SHA1 signatures are rejected as generic authentication failures
  before enqueueing. Malformed inputs are assigned a fixed dummy presented digest and
  traverse the same fixed candidate HMAC/compare loop and response envelope as an
  HMAC mismatch: same HTTP status, header names/order/values, body bytes,
  `Content-Length`, cache headers, and bounded timing floor, with detailed parser
  reason logged only after the response is committed. The malformed-input path does
  not normalize, truncate, compare partial prefixes, or choose first/last duplicate
  headers. Webhook secrets are generated and loaded as 32-byte random byte arrays, not
  variable-length strings. The receiver always builds a fixed two-slot candidate
  array: current secret and previous-secret-or-32-byte-dummy, with version/window
  metadata masked into the final decision after comparison. Both slots are exactly
  32-byte buffers and both expected HMAC digests are computed unconditionally over the
  same raw payload bytes before any replay store lookup, using the same helper and a
  fixed slot count; sequential computation is allowed only because the slot count and
  key length are fixed, and an implementation may compute them in parallel if it
  preserves the same observable behavior. For every request that reaches signature
  verification, the receiver performs equal-length constant-time comparisons for
  every slot regardless of match or mismatch, combines match bits with bitwise
  OR/result masking in a full-length loop, and rejects the entire request only after
  the full candidate set has been tested. It accepts only a matched candidate whose
  `not_before`/`not_after` window is valid. The required implementation pattern is
  `crypto.timingSafeEqual` or
  equivalent for each candidate, fixed-count loop iteration, no `some`/early
  `return`, no per-candidate exceptions, no per-candidate internal state in logs or
  traces until the loop completes, and tests showing equivalent behavior and bounded
  timing distributions when the matching secret is current, previous, dummy/absent,
  or outside its validity window. The launch bound is p95 delta <= 10 ms and p99
  delta <= 25 ms between signature failure classes over at least 100,000 warmed
  samples against the built receiver artifact; production records the same histograms
  and disables hosted ingress, relying on GitHub redelivery, if drift exceeds the
  bound for three consecutive five-minute windows. The verifier module is static, has
  no dynamic code generation, and its timing tests run against the production bundle,
  but this is a remote timing mitigation, not a claim against local microarchitectural
  observation of the receiver process. Only after the full signature loop completes
  does the receiver consult the replay store. The replay decision receives the immutable
  match-bit set from that just-completed HMAC loop; replay-store state alone is never
  authentication. Old-secret duplicate acceptance requires both the old-secret match
  bit for the exact immutable raw payload bytes just hashed and an existing
  pre-activation replay row. Delivery ids are recorded with a 24-hour replay TTL
  before enqueueing, keyed with installation id, repository id when present,
  delivery id, payload hash, action, and accepted secret version. The installation id
  is parsed from the signed payload before replay insertion and must match the row's
  tenant scope before any job or control event is enqueued. New replay rows may be
  inserted only for the current secret version
  or for the first accepted delivery before `new_secret_active_at`; an old-secret
  match during grace is never allowed to create the prior replay record it needs for
  acceptance. This is an explicit read-then-conditional-insert flow with no upsert:
  if the old-secret match has no existing pre-activation replay row, verification
  fails before any replay record is inserted. Current-secret first-delivery insertions
  run in a serializable transaction with a unique index over the replay key above;
  old-secret duplicate checks use `SELECT ... FOR UPDATE` on the existing
  pre-activation row and never execute an insert path during grace. After signature
  and replay handling, the receiver classifies authorization-control events before no-op filtering:
  `installation`, `installation_repositories`, `membership`, `member`, `organization`,
  `team`, `team_add`, `repository`, and any documented permission, suspend, delete,
  transfer, visibility, SAML/IP, or policy event bypass the non-PR no-op path and are
  persisted into a durable coalescing control log before processing limits are
  applied. Only after that control-event check may the receiver acknowledge remaining
  non-PR events, comments without an `@prowl-review` mention/command, and other
  signed no-op noise without consuming review, command, or authorization-control
  quota. Relevant review and command deliveries use separate per-installation buckets
  so public comment noise cannot starve review starts. If control processing is
  saturated, the system fails closed by bumping auth generation, cancelling affected
  leases, blocking new decrypts/job claims, and reconciling
  installation/repository/permission state from GitHub before reopening the scope.
  App-wide and source-rate abuse buckets still
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
webhook retries without local replay/idempotency state. Per-installation webhook
secrets are also rejected for the managed GitHub App because GitHub App webhook
delivery supports one App registration secret, not tenant-specific webhook secrets;
blast-radius reduction must come from strict signature/replay validation, tenant
authorization after verification, zero-grace App-wide rotation on compromise, and
suspending affected processing until rotation completes. If GitHub later supports
per-installation webhook secrets, that becomes the preferred managed rotation model.

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
versions, include direct inspection evidence from the GitHub App's registered
private-key list or audit/export proving those key ids are no longer active on
GitHub, name the replacement managed key version generated after the cutoff, and
include a production canary showing a retired key cannot mint an installation token.
The credential-rotation record is a policy document signed by two distinct
release/security operators from the approved quorum using hardware-backed signing
keys registered in the policy store; service principals and the runtime deployment
identity cannot satisfy either signature. It includes the App id, cutoff time,
revoked key ids/fingerprints as displayed by GitHub, replacement managed key id,
change ticket, evidence hashes, and the canary result. Verification reads the current
GitHub App private-key inventory from the GitHub-provided App settings surface,
audit/export, or documented API available in the deployment environment; if only the
settings UI is available, two independent operator captures are required and the lack
of machine-readable evidence is itself recorded. The canary signs a GitHub App JWT
with the sealed retired key material and calls GitHub's installation-token endpoint
for a controlled installation; only a GitHub-origin `401`/invalid-signature response
counts as proof, while local preflight rejection, network failure, or missing
installation access is inconclusive and blocks launch. The canary is supporting drift
evidence, not a substitute for GitHub-level key-list verification. The canary and
key-inventory verification run in production before opening external installs, at
managed App startup, after any key rotation, and at least daily as a scheduled drift
check; failure pages the on-call and immediately disables external installation
acceptance, hosted token minting, and review enqueueing for the managed App until
operators either repair the revocation evidence or migrate to a new App identity. If
GitHub-level revocation cannot be verified with high confidence, the managed service
must register and provision a new GitHub App identity whose private key was never
distributed to Actions; migration docs then map old Action markers to the new bot
only through the explicit marker-copy job above. The managed App signing credential
lives only in the managed secret store, HSM, or token broker used by the hosted
token-minter; it is never stored in this repository, workflow secrets, Action logs,
or customer repositories. The Action path must use `GITHUB_TOKEN`, a user-owned
GitHub App credential scoped to that operator, or a brokered token that can mint only
for the current repository/workflow and cannot mint across managed hosted tenants.
Sharing the managed App signing credential with Actions is a launch blocker.

Uninstalling the `prowl-review` App immediately disables hosted reviews and token
minting for Action workflows that depend on that App. The uninstall webhook is a
lossless control event: it bumps lifecycle/auth generation, cancels hosted jobs,
marks `delivery.owner: app` state as unavailable, and records a durable uninstall
status that the Action reads before attempting App-token minting. Existing Action
workflows fall back to `GITHUB_TOKEN` only when they are written with the current
tolerant token-minting path; otherwise they fail visibly with an "App uninstalled;
set `delivery.owner: action` or reinstall/reconfigure" message rather than silently
losing review coverage.

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
and no Prowl Action or reusable Action workflow file exists in the trusted-base tree.
A present-but-disabled, skipped, broken, renamed, or non-running workflow still
counts as Action ownership and cannot trigger hosted failover. Workflow file
detection cannot override an explicit config owner and is re-run from the trusted
base before claim; repos that want hosted failover must set `delivery.owner: app` in
trusted-base config rather than relying on workflow failure detection.

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
   non-state-changing commands only when it was minted from GitHub for the same
   `{installation, repository, sender, required_role}` within the last 60 seconds.
   Positive entries use a hard, non-sliding expiry, are evicted by a minutely sweeper,
   are dropped on process restart, and are never refreshed by cache hits. Enterprise,
   branch-protection, SAML/IP, admin, key-setup, provider-backed, privileged, and
   state-changing commands cannot rely on that cache for authorization; at most it
   suppresses repeated unauthenticated ingress before the required fresh GitHub read.
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
   The command claim transaction and permission-change generation bump both lock the
   same installation auth row through serializable isolation, `SELECT ... FOR
   UPDATE`, or a compare-and-swap version update; asynchronous invalidation workers
   may enqueue work, but the generation bump itself is synchronous with webhook
   ingestion before ack. The claim transaction reads the current auth generation
   inside the transaction; any generation from the earlier prefilter cache is treated
   only as an expected value and never becomes authority. If that expected value
   differs from the locked row, the transaction rolls back before writing or consuming
   a command record, records a `stale_prefilter_generation` audit event, and re-enters
   authorization only by locking the installation auth row and command row in a new
   serializable transaction before making the fresh GitHub permission API read. The
   old cached result is discarded and can never authorize the retry. If the generation
   changes again before the fresh read result is reserved under the locked row, the
   command reaches terminal `stale_authorization`/`authorization_changed` rather than
   proceeding. At most one fresh read applies only to retrying a transient GitHub API
   read, not to retrying the generation check or command authorization decision. It
   never tolerates a generation mismatch and never claims work under the old cache
   generation. If a permission-change webhook lands after the prefilter but before
   claim, the generation bump wins or forces the claim transaction to retry/fail
   before any command record can be consumed. Claimed command records store the auth
   generation used for authorization, and the handler re-checks that generation plus
   performs the fresh GitHub permission API check through the same guarded-send
   pattern immediately before each provider or GitHub side effect; a stale generation
   alone can never authorize execution. The handler records the locked auth
   generation before starting the fresh GitHub permission API read and compares it
   with the locked row again inside guarded send after the read returns. If a
   permission-change webhook bumps the generation while that GitHub API call is in
   flight, the result is discarded as stale before any side-effect reservation is
   written; the command then follows the same single fresh-read retry or terminal
   `authorization_changed` path described here. If a permission-change webhook
   invalidated the cache after the fresh check but before an external call, the
   guarded send sees the generation mismatch, aborts, and no side effect starts. If a
   permission-change webhook invalidated the cache mid-command, the consumed command record remains
   consumed and transitions to terminal `authorization_changed` with the old and new
   auth generations, abort reason, and side-effect reservation state. It is not reset,
   re-queued, or automatically retried. The normal status/comment/check channel
   publishes a single user-visible `authorization_changed` response when the App still
   has permission to publish; otherwise the terminal audit event and installation UI
   show that the sender must re-run the command after permissions settle. There is no
   automatic retry for provider-backed, state-changing, or privileged commands after
   authorization invalidation because retrying could execute after a role downgrade
   without explicit user intent. Operationally, guarded send is one helper:
   after the fresh GitHub permission API result returns, it opens a serializable
   transaction, locks the installation auth row and command row, confirms the auth
   generation and sender/role/scope still match, consumes any provider-call nonce or
   publication reservation, writes a side-effect fencing token, commits, and then
   immediately opens the external request in the same call stack without unrelated
   awaits, timers, or queue hops. The request builder requires that fencing token and
   performs one final local generation read before opening the socket; a webhook
   generation bump that lands between the API read and socket open either blocks on
   the same row lock or makes that final read fail. A revocation that occurs after the
   final local read but before the first outbound packet leaves the process remains a
   residual GitHub/event-delivery race, is bounded by the guarded-send telemetry in
   Decision 2, and is not claimed as atomic cancellation. State-changing,
   privileged, or provider-backed commands,
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
   opened and again on key-save POST: the OAuth/App session user must match the
   command sender, the installation id and repository id must match the signed link
   record, and GitHub/allowlist state must confirm the same elevated role using the
   same current membership-reading authority. These settings GET/POST authorization
   checks bypass the positive permission cache entirely and read GitHub/allowlist
   state under the current installation auth generation; cache-hit attempts in this
   code path must return a sentinel failure, alert, and abort the render/save rather
   than silently authorizing. If the elevated role cannot be confirmed at either gate,
   or if the auth generation changes between the fresh read and the render/save
   transaction, the command fails closed, any opened nonce is invalidated so later
   privilege regain requires a new command, and the failure is audited.
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
   fragment. Webhook payloads may enqueue edit work but cannot create the canonical
   consume-once record. Edited comments create a distinct consume-once record keyed by
   that API-read timestamp and digest only after a comment-level execution lock keyed
   by `{installation, repository, pull_request, comment_id}` is available. After the
   lock is acquired, the handler performs the fresh GitHub API read that supplies the
   authoritative `updated_at` value, full body digest, parsed verb, and head SHA. If
   the API state no longer matches the queued delivery, the queued version is recorded
   as superseded without creating a consume-once record, and the latest queued edit is
   processed behind the same lock. While holding the lock, the handler allocates a
   monotonic local `comment_version_seq` for the current API state and inserts the
   consume-once row through a unique constraint over `{installation, repository,
   pull_request, comment_id, api_updated_at, body_digest, parse_version, verb}` plus
   the local sequence. Insert conflicts are treated as duplicates and do not execute
   again; identical `updated_at`/digest/verb values represent the same observed
   comment version, and different digests under the same GitHub timestamp serialize
   through the local sequence. The lock intentionally excludes the mutable parsed
   command verb, PR head SHA, and lifecycle generation so every edit of one comment
   serializes behind the same comment identity. That lock is held from claim through
   command terminal state, including provider calls and publication, with its own
   lease and fencing token. The handler fetches the current GitHub comment again and
   validates that its `updated_at` value/body digest still matches the claimed
   delivery immediately before side effects; if it advanced, the in-flight command
   aborts as superseded and records the current version for later processing. If an
   edit arrives while the lock is held, the newer edit is durably queued behind the
   lock and re-authorized after the current command reaches terminal state; it is not
   dropped through a Retry-After-only webhook response because GitHub will not
   redeliver it automatically. Delivery-id
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
single-use, requires cache-bypassing fresh GitHub OAuth/App authorization with the
installation-admin definition above on both settings GET and POST, and carries no key
material in the URL. OAuth
state and the explicit signed CSRF token must commit to the nonce hash/link id,
session id hash, sender id, installation id, repository id, row version, and expiry
before accepting a provider key. The OAuth-authenticated GitHub user id on the
settings GET and POST must exactly equal the signed sender id from the command
webhook; a mismatch fails with the same generic unauthorized envelope, invalidates no
other user's nonce, and audits a possible social-engineering attempt. The first
authorized settings GET transactionally binds the nonce row to that same-sender
session before rendering the key input only with a predicate that includes
`expires_at > database_transaction_timestamp()` and `consumed_at IS NULL`; expired
nonces cannot be bound even if cleanup has not run. That bind is a single
serializable `UPDATE ... WHERE nonce_hash = ? AND row_version = ? AND expires_at >
database_transaction_timestamp() AND consumed_at IS NULL RETURNING ...` or equivalent
row-locked compare-and-swap; read-committed read-then-update flows are not allowed.
Cleanup is storage hygiene only and is never part of authorization. The key-save POST
must happen over HTTPS with the same authorized same-sender session and a fresh
cache-bypassing GitHub/allowlist elevated-role read reserved through the guarded-send
auth-generation pattern above. Nonce consumption plus key persistence must commit in
one transaction using the same database-clock expiry predicate plus nonce hash,
session-binding hash, sender id, OAuth user id, installation id, repository id, row
version, locked auth generation, and `consumed_at IS NULL`; a second request,
different session, different OAuth user, expired nonce, cache-hit authorization
attempt, or permission-change generation mismatch gets a generic used/expired or
unauthorized response and cannot write a key.

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
   org-membership permission/reapproval for org key setup, deletion lifecycle,
   explicit managed-custody warning in install/migration/key-entry UX, and either the
   audited native key-ingestion worker or an external secret-helper/sidecar vault.
4. API-retrieval adapter for the core's repo-tools interface with the Decision 2
   bounds and incomplete-review states.
5. Provider HTTP reference wrapper, canonical provider mock, equivalence harness,
   canary fixtures, dependency provenance report, timing/drift monitors, and
   two-security-reviewer launch record.
6. Runner + posting path (core unchanged) + command authorization/replay handling,
   blocked on step 5 for any provider call.
7. Self-host packaging (Workers deploy button + Dockerfile) and SECURITY.md/docs.
8. Beta on our own repos → publish policy docs/limit defaults → announce.

Each step lands as its own backlog item once #47 is un-parked; this doc's approval
is the gate.
