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
Cloudflare Workers + Queues for receiver/orchestration only, with the runner tier
defined in Decision 2. Workers is not an eligible runtime for key ingestion,
provider-key decrypt, or provider HTTP calls unless it can prove the native
memory-locking and process-isolation controls in Decision 1; managed v1 must use a
hardened ingestion service, sidecar/broker, container runner, or alternative platform
for those key-handling paths, or managed launch remains blocked.

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
are the only managed v1 implementation classes allowed without a new security
decision: (1) pinned N-API/libsodium using `sodium_malloc`, `sodium_mlock` or
platform-verified locked pages, and `sodium_memzero`; (2) an external hardened secret
broker over authenticated local IPC whose process owns plaintext and locked memory;
or (3) a platform enclave/secret service with equivalent no-swap, no-core-dump,
no-debug, and explicit-zero guarantees. Startup self-tests must prove the selected
path can lock memory, block core dumps/swap/inspector access, zero a canary buffer,
and fail closed when any control is unavailable; platform-specific alternatives need
the same equivalence report and two-person security approval before deployment.
Managed v1 has no approved key-ingestion implementation until a follow-up PR selects
one of those classes, adds the named worker/broker path, key-ingestion test harness,
startup self-test, SBOM/dependency provenance, and
`docs/security/hosted-key-ingestion-launch-record.md`, and records approval from the
same two-person security-owner quorum used for provider egress. Build-plan step 4 is
the tracked artifact for this gate; approval of this design record un-parks that work
but does not allow key-save traffic. These controls reduce persistence after save, but
they still do not protect against malicious code or an operator already executing
inside that worker during the live save window. Application code cannot prevent V8 from
creating persistent or interned plaintext strings once a framework, parser, template,
logger, or validation helper
observes the key as a JavaScript string. Managed v1 key ingestion therefore must route
raw request bytes to the native helper, local secret broker, or platform secret
service before app-level parsing; any candidate implementation that requires
plaintext provider keys to pass through normal JavaScript string APIs is not launchable
unless a new security decision explicitly accepts and discloses that residual risk.
Hosted key entry must use an isolated raw-body POST endpoint with a provider/key-type
selector outside the key payload; JSON, GraphQL, form-urlencoded, multipart fields,
template variables, or framework body parsers that materialize the key as a JavaScript
string are forbidden on the managed key path.

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
before redaction. Launch requires a measured decrypt-to-send budget: staging tests
record wall-clock time from successful decrypt return to the first provider request
byte leaving the runner process and fail if p99 exceeds 100 ms or max exceeds 250 ms
under representative load and contested event-loop conditions. Once plaintext key
material is available, request construction and transport handoff run in one guarded
synchronous call path with no `await`, timer, queue hop, microtask yield, or callback
that can sit behind unrelated review work. If event-loop lag, HTTP-client scheduling,
or async wrapper behavior can extend the measured handoff window, or if the minimal
client requires provider-key material to live in JavaScript strings outside that
window, managed launch requires a native secret helper, sidecar vault with locked
memory, or equivalent transport shim before provider traffic is enabled. The full
provider-call window also has a hard outer deadline, measured from decrypt start
through request send, response streaming, response finalization, and `finally`; managed
v1 defaults to 120 seconds and cannot exceed 180 seconds without a new security
decision. Timeout aborts the provider stream, zeroes owned key/header/response buffers
in `finally`, marks the job incomplete rather than retrying the same request object,
and recycles the runner. The launch record must publish provider-specific p95/p99
successful-call latency, DNS/TLS timing, and timeout rates under representative
provider and network conditions, with enough headroom that normal successful calls do
not approach the hard deadline. The decrypt-to-send startup and staging suite must
deliberately create CPU contention, GC pressure, large-buffer allocation, and event-loop
lag; if p99 exceeds 100 ms or max exceeds 250 ms, managed launch either switches this
path to a native transport shim or requires a new security decision with a larger
published risk budget. Production records decrypt-to-send p50/p95/p99/max histograms;
two consecutive five-minute windows over p99 100 ms or any max over 250 ms disable
hosted provider calls for the affected runner class and page on-call until repaired.
Each
attempt obtains a fresh lease/fencing snapshot, provider-call nonce, and decrypt
authorization tied to the current revocation generation; retries cannot reuse any of
those values. The control plane consumes the provider-call nonce and grant in the same
transaction that authorizes decrypt, with a unique key over
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

The provider HTTP client is a launch-blocking security component. This design
document defines the approval criteria only; it does not approve any implementation
or unblock provider traffic. The first launchable implementation must be a named
reference wrapper over Node's `undici`/WHATWG `fetch` streaming primitives, and an
equivalent wrapper is ineligible until the reference harness includes it and tests
prove the same behavior. The wrapper has no middleware cache, no automatic
redirects, no automatic retries, no request/response buffering beyond the active
socket or one bounded read chunk, no automatic request object retention, no debug
hooks, and no logging of serialized request/response objects. Its runtime dependency
set is explicitly allowlisted, pinned by the
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
fixtures before it can be enabled. Build-plan step 5 below is the tracked artifact
for this gate; approval of this decision record can un-park implementation planning
but not managed runtime launch. The signed launch record must name the wrapper repo
path, implementation commit, canonical mock path, fixture corpus version, minimum
pass criteria, timing/drift thresholds, SBOM and pinned dependency versions, startup
self-test behavior, failure-mode behavior, and two security reviewers from the
security-owner quorum. Managed v1 bans provider SDKs, SDK middleware/plugin systems,
retry/redirect helpers, proxy-agent/global-agent packages, request instrumentation,
and generic HTTP clients outside the named wrapper on the provider-key path unless a
future design decision adds them to the same harness and launch record. The initial
reserved artifact names are `src/hosted/provider-http-client.ts`,
`test/hosted/provider-http-client.test.ts`,
`test/fixtures/hosted/provider-mock.ts`, and
`docs/security/hosted-provider-http-launch-record.md`; step 5 must either create
those paths or update this decision before provider traffic can be enabled. The
security-owner quorum is two repository maintainers with write/admin access who are
not the wrapper author and not the production deployment approver; their approval is
recorded as GitHub review approvals on the launch-record PR plus their names and
commit SHAs in the launch record. Deployment and runner startup load the launch
record from the exact deployed commit and fail closed if the named wrapper path,
fixture corpus, dependency lockfile, signed reviewers, or drift thresholds do not
match. The
launch maximum buffered provider response chunk is 64 KiB before the runner performs
a revocation check and either processes that chunk or discards it;
larger read-ahead or full-body buffering blocks launch. The 64 KiB limit is per
application read and per revocation-check interval, not the cumulative provider
response size; cumulative accepted provider bytes are streamed through the parser under
a separate per-provider attempt cap published in the launch record, with managed v1
starting at <= 2 MiB unless a provider-specific measurement justifies a lower cap.
Large provider responses are acceptable only when the chosen transport can split them
into application reads at or below 64 KiB with a revocation check between reads. The
wrapper must enforce the chunk limit at the response reader: if a read would exceed 64
KiB or the cumulative cap would be crossed, the wrapper aborts the provider request,
zeroes/discards the partial chunk, marks the provider attempt incomplete with no retry
of that request object, and recycles the runner. Continuing to parse or summarize an
over-limit chunk is launch-blocking. This is an active in-application buffer bound,
not a guarantee that the kernel, TLS stack, socket
receive buffer, or HTTP library has no bytes already in transit or internally
buffered before the application read. Managed launch must either configure the runner
socket/container to cap receive buffers at the same bound or publish the measured
lower-layer residual exposure in the launch record; if HTTP-library internal buffers
can expose more than 64 KiB to the Node process after revocation, the wrapper is not
launchable without a native transport shim or network-level buffer shaper. The wrapper
must perform a startup self-test against a provider mock that attempts over-buffering
and slow-streams data so revocation fires between reads; the test includes <=64 KiB,
64 KiB + 1 byte, 500 KiB, and cumulative-cap-crossing responses, records actual
in-process bytes reachable after abort, verifies large responses are either safely
streamed or marked incomplete, and exposes a metric/alert if any application read
exceeds the bound. Revocation observation
synchronously marks the attempt revoked and requests stream abort, but Node.js stream
cancellation is asynchronous. The wrapper must enforce the 64 KiB limit at the reader
level without relying on abort-signal timing, must never full-body/read-ahead buffer,
and must discard or zero owned buffers on the next event-loop turn. The control plane
enforces a hard process kill after a 1-second deadline if the stream is still open;
this is best-effort containment, not a claim of synchronous in-flight stream
cancellation. No cached request object may be retried. Tests must include
post-attempt canary scans
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
is disabled in production. Debugging and incident response use only the sanitized
provider class, retryability, request id, correlation id, and timing counters above;
raw provider error details and stack traces are intentionally unavailable unless a new
security decision creates a separate redacted evidence channel. Launch-blocking CI and
staging tests must include canary
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
For repository-scoped key configuration under an org installation, org-owner status
alone is not enough: the same fresh GitHub read must also confirm that the sender can
write the target repository's trusted-base `.prowl-review.yml` scope, or is in the
audited installation-admin allowlist for that repository. A fresh grant read occurs
at command/link creation, again before settings GET render, and again immediately
before settings POST commit. The GET grant version is stored on the nonce row, and the
POST transaction locks the nonce/auth rows, repeats the GitHub/App or OAuth read, and
requires the current grant version plus repository-write/config authority to still
match before any key candidate is persisted. Any permission-change webhook, 403/404,
grant downgrade, repository access loss, or generation mismatch between GET and POST
fails closed with a generic authorization response, invalidates the nonce, surfaces a
reapproval/retry prompt when safe, and writes no key.
The command handler performs this fresh installation-admin check synchronously inside
the guarded command/link-creation path immediately before creating a settings link;
if the auth generation changes between the command authorization check and nonce
creation, the link transaction aborts and no key material can be handled. The settings
GET and POST repeat the same current-admin check before rendering the key input or
accepting key bytes.
`@prowl-review configure key` never accepts a raw key in a public comment; it only
opens a short-lived, single-use settings link after the command authorization in
Decision 5 succeeds. Immediately before nonce creation, the command handler re-reads
the current GitHub comment under the comment-level execution lock described in
Decision 5. The current `updated_at`, full-body digest, parse version, verb, sender,
command occurrence id, parsed arguments, and head SHA must still match the claimed
`configure key` command, and the normalized body must contain only the allowed command
shape with no raw provider key or conflicting key-setting arguments. Multiple
`@prowl-review` commands in one comment are parsed into separate command records with
distinct occurrence ids; they are never combined into one `configure key` link. If the
body was edited, removed, reparsed as a different command, or reparsed with different
arguments or command occurrence, link creation aborts as superseded and the event is
audited. The
settings hostname must be HTTPS-only at the network
boundary: the load balancer/reverse proxy rejects cleartext HTTP before application
code, nonce lookup, cookies, OAuth state, or CSRF validation can run, and it must not
redirect an HTTP request while preserving the path or query. The settings domain is
HSTS preloaded, or launch remains blocked until the preload submission is accepted
for the exact host or parent domain that covers it. The link is an App URL on that
preloaded HTTPS origin and contains only an opaque nonce
generated with `crypto.randomBytes`, WebCrypto `getRandomValues`, or an equivalent
OS-backed CSPRNG. The nonce has at least 128 bits of entropy, is never derived from
session/user/comment ids, has only a server-side hash persisted, and is redacted from
application logs. Before the settings service binds an HTTP listener or accepts
traffic, it must run a startup self-test through the exact configured nonce
generator: generate at least 16 bytes, reject all-zero/all-one or repeated canary
outputs, verify both set and clear bits exist, and fail closed with alerting if the
OS entropy source is unavailable, blocked, or throws. The same startup gate must also
verify the platform entropy source directly for the deployed runtime: `/dev/urandom`
readability and nonblocking behavior on Unix-like hosts, `getentropy()`/platform CSPRNG
syscall success where exposed, or HSM/entropy-service health and policy status when
that source backs nonce generation. Runtime nonce generation errors
must never fall back to Math/random, timestamps, counters, session ids, or weaker
sources; they return the generic failure envelope and alert. Issuance is
rate-limited and capped to one active unexpired
key-setup nonce per `{installation, repository, sender, comment_id}` plus a small
per-sender rolling limit; exceeding either cap denies a new link and audits the
attempt rather than creating many concurrent unexpired nonces. The signed link record
commits to installation id, repository id, sender id, comment id, comment
`updated_at`, full-body digest, parse version, verb, head SHA, nonce, and expiry; the
settings UI displays the target owner/repo before save and refuses
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
session, and source address. It performs constant-shape local format validation.
Local format validation means only provider-agnostic byte-length bounds, UTF-8/raw-byte
decodability needed by the selected storage path, and an allowlisted character-class
scan that runs over every submitted or dummy key buffer without early returns. It does
not check provider-specific prefixes, token shapes, or semantic key classes before the
generic response; if a provider requires a prefix check, every provider adapter must
execute the same fixed validation path over dummy and submitted buffers with full-length
iteration, bitwise validity masks, and conditional assignment only. The scan never
exits early or takes a branch based on the first invalid character, prefix, length, or
provider type, and prefix mismatch is not reported before the generic response
deadline. If a provider's semantic key validation cannot be represented by that fixed
local loop, the provider is not launchable until the post-response background validator
can check it without exposing user-queryable pending state. Managed v1 performs no synchronous live provider
validation and opens no provider network connection before the response is committed.
Provider auth validation runs only after the generic response, from an inactive
pending-validation candidate, in the bounded background validator below. Adding
synchronous live validation to the managed App requires a separate design update and
launch gate that proves no timing distinction between no-call, success, timeout,
denied, and provider-error paths. If
background live validation fails or is unsupported, provider error bodies are not
serialized, cached, returned, traced, or logged; they are mapped to a fixed internal
enum such as `invalid`, `unauthorized`, `rate_limited`, or `unknown`. `invalid`,
`unauthorized`, `rate_limited`, `unknown`,
and validation-unsupported results never replace an existing verified key and never
promote a key for reviews. They either persist no key material or store only an
encrypted pending-validation candidate that is not part of the active provider-key
table, is invisible to runners, and is eligible only for a bounded post-response
validation job. Providers without a supported bounded pre-use validation path are not
launchable in managed v1. The endpoint responds under a fixed wall-clock response
budget, with identical HTTP status, headers, and body bytes for `invalid`,
`unauthorized`, `rate_limited`, `unknown`, validation unsupported, skipped
synchronous validation, and nonce/session race-loss outcomes. The immediate response
never distinguishes saved, validation pending, or not-saved; later authenticated
settings views expose only terminal `key_valid`, `key_required`, `key_invalid`, or
`key_expired` states and never include provider details. "Identical" means the same status code, same header
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
dummy credentials and never contact the real provider. Nonce, session-binding, CSRF,
Origin, and key-fingerprint comparisons use fixed-length HMAC or digest buffers and
`crypto.timingSafeEqual` or equivalent; variable-length strings are decoded to fixed
candidate buffers plus validity masks before comparison. Nonce lookup uses one
prepared query shape over a keyed nonce hash and indexed tenant/scope columns for
present, absent, expired, and consumed rows, followed by the same dummy-row merge and
authorization transaction shape. The design does not claim database planner constant
time or KMS constant time; launch records must publish per-operation p50/p95/p99/max
for nonce lookup, session binding, CSRF/Origin validation, KMS/envelope operations,
dummy path, and total request timing, and production histograms include those classes
inside the fixed response floor. Authorized saves create only
an inactive pending-validation candidate for later guarded validation. The last
verified key remains active until a
new candidate validates; if no verified key exists, reviews remain disabled because
there is no usable key, not because an `unverified` row replaced authority. Staging
and production key-save code never compares submitted key material to stored key
material with string equality, prefix checks, length-dependent early exits, or direct
plaintext byte comparisons. If the save path needs duplicate/overwrite detection, it
computes fixed-length keyed fingerprints such as HMAC-SHA256 over the submitted and
stored-key records and compares only equal-length buffers with `crypto.timingSafeEqual`
or equivalent. Key-match and key-mismatch paths perform the same database reads,
candidate writes, dummy validation work, response delay, and provider-call decision
snapshot so timing does not reveal whether a retry supplied the same key.
Staging timing tests must issue repeated
`invalid`, `unauthorized`, `rate_limited`, `unknown`, validation-unsupported, expired
nonce, session-race, absent-key, valid-prefix, invalid-prefix, minimum-length,
maximum-length, overlong, and invalid-character requests and block launch if p95/p99
distributions diverge beyond the published bound. The managed v1 launch bound is p95
delta <= 25 ms and p99 delta <= 50 ms between any two failure classes over at least
10,000 staging samples per class, after warmup, measured from ingress accept at the
load balancer to the last response byte written, including framework parsing,
nonce/session/CSRF/OAuth checks, database/KMS calls used by that path, and any local
validation work. Because
managed v1 never performs a synchronous provider auth probe, the endpoint always
returns the same generic pending envelope after the local constant-shape checks and
enqueues or refreshes only a pending-validation candidate. That candidate has
per-installation, per-sender, and per-source creation and
retry limits stricter than the command-ingress buckets; repeated pending candidates
coalesce by installation/provider and cannot make an existing verified key unusable.
No user-facing endpoint reveals pending-validation candidate existence, provider error
reason, attempt count, or validation timing. Settings UI and APIs expose only terminal
states: `key_valid`, `key_required`, `key_invalid`, or `key_expired`; until a candidate
reaches a terminal result, the authenticated user sees the same generic post-submit
state they saw immediately after save. Background validation outcomes stay in
append-only audit/operator state with staff/audit access and query logging.
The background validator uses the same guarded provider-call path, never starts while
another validation for that installation/provider is active, destroys failed or
superseded candidates, and promotes exactly one candidate to the active verified-key
table only after successful validation in a serializable compare-and-swap
transaction. The validator publishes a heartbeat at least every 30 seconds per
installation/provider shard and records `started_at`, `finished_at`, outcome, attempt
id, and candidate id for every validation attempt. A pending-validation candidate that
has no terminal validation result within 1 hour expires automatically, is removed from
the pending table, alerts on-call after repeated occurrences, and never becomes
runner-authoritative. Runners read only the active verified-key table; if no verified
key exists, reviews remain disabled with `key_validation_pending`/`key_required`
status and approval withheld. The no-live-probe path releases responses only at the configured
deadline with the same dummy validation work for every immediate outcome. If either
that path or the later guarded validation cannot meet its own published bound, launch
is blocked. The residual timing threat
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
materialize credential-bearing headers, and hand the request to the audited HTTP
wrapper in the same call stack without unrelated awaits, timers, or queue hops. URL,
body, and non-credential header preparation must complete before decrypt/final check;
only credential-bearing header assembly and the wrapper `send` invocation may occur
afterward. The published managed v1 bound for final-check-to-wrapper-handoff is p99 <=
100 ms and max <= 250 ms in staging for the chosen runtime; launch is blocked if that
path is unmeasured, contains avoidable async gaps, or exceeds the bound. DNS, TLS, and
provider processing after wrapper handoff are already part of the external request and
remain residual cross-system exposure; this is not a promise of atomic or
microsecond-scale cancellation in Node.js. The
GitHub publication path uses the same guarded-send boundary: the helper locks the
installation state row and review/publication row, re-reads revocation generation,
allocates a publication-reservation fencing token, commits, and opens the GitHub API
request in the same call stack without unrelated awaits. If revocation is observed
before the request opens, no publication reservation is written; if it is observed
mid-call, the response is discarded, the reservation is failed, and no retry can
publish without a fresh guarded-send reservation. The
worker control plane also cancels active provider HTTP streams, sends a graceful
termination signal to active runner processes after the revocation transaction
commits, and escalates to a hard kill after a short published deadline; fencing
remains authoritative if a process cannot be reached. A provider request already on
the wire cannot be recalled and may consume quota, reach provider logs, or continue
server-side after the local stream is aborted. A revocation that lands after the
final local check but before the external API receives the request is an unavoidable
cross-system race; the launch docs must disclose it. If revocation is observed while
a provider response is streaming, the runner requests abort immediately, stops
requesting further chunks, and discards bytes already received without parsing.
Revocation handling is sequenced as signal, abort request, buffer discard or
zero-owned-buffers best-effort, then process exit or hard kill if the stream is still
open after the abort deadline. The wrapper's reader-level 64 KiB bound, not
abort-signal timing, limits in-process response exposure. The runner must re-check
revocation after response headers, before and after every bounded response chunk, after stream
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
  adapter rejects symlinks, submodules, mode/type mismatches, and requested or
  resolved paths that would violate the sensitive-path denylist; accepted reads fetch
  the blob by the verified tree-entry SHA or prove the Contents response type and SHA
  match that preflight before bytes enter the retrieval cache. A Contents type/SHA
  mismatch, missing blob, or symlink response after preflight is a completeness
  failure: the adapter discards response bytes without caching them, stops mixing
  snapshots for that ref, marks the review incomplete, and reports that the file
  changed or could not be verified during retrieval. Every page, retry attempt,
  response byte, and retrieved byte counts against the request, response-size, and
  timeout ceilings below. The adapter treats Git tree `truncated` responses,
  incomplete PR-file pagination, missing required blobs, and exact-read SHA/type
  mismatches as completeness failures.
  Grep/find-reference behavior runs only over the proven-complete bounded tree/file
  cache. `find_definition`/`find_references` first use bounded tree reads and local
  grep over that cache. If the retrieval planner or tool contract determines that
  complete caller/callee discovery requires GitHub code search, it emits an explicit
  `requires_search` request with reason, query, language/symbol scope, and whether the
  search is required or optional; search is never invoked implicitly from an empty grep
  result. For private repositories, private forks, private submodules, private
  dependency scopes, or any unknown visibility state, required search fails as
  `private_repo_search_unavailable` and marks the review incomplete rather than
  returning empty results; optional search is skipped with the same caveat. Every
  retrieval endpoint validates installation id, repository id, visibility, requested
  ref, and path bounds before making a GitHub request. GitHub
  code search is disabled for private
  repositories in v1 at the API-client capability boundary, not only at call sites:
  the search helper rejects private-repo requests before building REST/GraphQL
  search calls, and tests assert that no private-repo path can reach GitHub search.
  Repository visibility is a fresh-search precondition, not a cached hint: the adapter
  re-reads visibility immediately before each code-search call and again before caching
  or serving results. If a result was produced under a public visibility state and a
  later check shows private, unknown, transferred, renamed, or inaccessible visibility,
  the result is discarded without use, any cache entry for the prior state is evicted,
  in-flight search is aborted, and the review is marked incomplete with
  `visibility_changed` or the more specific access reason.
  The launch-blocking `api-retrieval-private-search-boundary` suite must run in CI
  before every managed retrieval deploy and in startup smoke tests. It covers
  private repository metadata, private submodules, visibility changes, renamed or
  transferred repositories, fork/private-base combinations, and public/private repos
  containing the same filenames. The suite fails unless private-repo search requests
  throw a client-boundary error before any GitHub search request is constructed,
  public-repo search requests still reach the mocked GitHub search endpoint, and
  public search cache entries cannot satisfy private-repo retrieval keys. The suite
  includes fixtures for a public repository whose Git tree contains mode `160000`
  submodule entries, a `.gitmodules` file pointing at a private URL, package manifests
  that declare private registry dependencies, a public fork whose parent/source is
  private or inaccessible to the installation, and a repository whose visibility flips
  during retrieval. Each fixture asserts that the adapter reports incomplete context
  with a specific reason such as `private_submodule`, `private_dependency`, or
  `visibility_changed`, and that no REST or GraphQL code-search request object is
  constructed even when the root repository is reported public. A separate fixture
  forces `find_references` to emit a required `requires_search` request on a private
  repository and asserts the review state becomes incomplete with
  `private_repo_search_unavailable`, not an empty result set or clean caveat.
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
  before search-heavy work. Rate-limit retries use exponential backoff with jitter,
  a 100 ms base, a 5-second per-sleep cap, at most 3 retries per request, and at most
  10 seconds of total rate-limit sleep inside the 90-second retrieval timeout. A
  `Retry-After` value above those caps is not slept in full; it terminates retrieval
  for the affected required context. "Stops retrieval before starving other jobs"
  means the runner ends retrieval for this review, releases its lease through the
  normal incomplete-review path, and reports missing context; it does not silently
  yield and later resume with unbounded delay. Bounded, known partial context is
  reported as a
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
  required security context is incomplete. The review state also carries an explicit
  `security_context_incomplete` flag whenever required security context is unavailable;
  the approval gate reads that flag independently of emitted findings, so approval is
  withheld even if no concrete security finding can be generated. The flag is the
  aggregate control-plane predicate produced by the required-context resolver, not a
  duplicate of reviewer prose: every explicit incomplete-context finding sets it, and
  resolver failures with no safe file/range to attach still set the flag and emit a
  single review-level incomplete-context note.
  A changed line is completely read only when its content is fetched from the Git tree
  by the verified tree-entry SHA, the response type and SHA match the preflight, the
  path is not denied as sensitive, and the line byte range is within the retrieved
  bytes. A changed line is incompletely read when the file cannot be fetched, the
  response type/SHA mismatches, the path is denied, the file/range exceeds bounds, or
  the byte range is unavailable; that triggers an incomplete-security-context finding
  naming the file, range, and reason. Missing callers, callees, manifests, or
  dependencies are surrounding-context incompleteness, not changed-line read
  incompleteness, but both set the aggregate flag and withhold approval.
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
  accepts only an entire header value matching the anchored
  `^sha256=[0-9A-Fa-f]{64}$` format with exactly 71 ASCII characters, exactly 64 hex
  characters after the prefix, and exactly 32 decoded bytes, plus exactly one
  `X-Hub-Signature-256` header after case-insensitive counting across the raw header
  list; an absent header is a hard verification failure. The parser must reject
  missing prefixes, prefixes with extra characters, whitespace/control characters,
  and suffixes after the digest. The parser validates that the character sequence
  after the `sha256=` prefix is exactly 64 characters and contains only hexadecimal
  digits before any attempt to decode, convert, hash, or compare the presented digest
  bytes. Any digest that is not exactly 64 hex characters, including 63-, 65-,
  66-character, overlong, padded, non-hex, or otherwise malformed inputs, is rejected
  without truncation, padding, prefix comparison, or length normalization; integration
  tests must cover 63/64/65/66 hex-character inputs and accept only a correct
  64-character HMAC. The receiver must iterate the raw wire header collection and reject
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
  not normalize, truncate, compare partial prefixes, choose first/last duplicate
  headers, or return early before the response floor. Header counting, prefix
  validation, length validation, and hex validation reduce into a single validity mask;
  the receiver still constructs the dummy digest, runs the fixed two-slot HMAC loop,
  and applies the same response delay for missing headers, duplicate/case-variant
  headers, malformed prefixes, too-short/too-long hex, non-hex characters, and
  valid-format mismatches. Webhook secrets are generated and loaded as 32-byte random byte arrays, not
  variable-length strings. Receiver startup validates that the current secret and any
  previous secret decode to exactly 32 bytes; a missing, short, long, UTF-8 string, or
  otherwise variable-length secret fails closed before the HTTP listener binds. The
  receiver always builds a fixed two-slot candidate array: current secret and
  previous-secret-or-32-byte-dummy, with version/window metadata masked into the final
  decision after comparison. Both slots are exactly 32-byte buffers and both expected
  HMAC digests are computed unconditionally over the same raw payload bytes before any
  replay store lookup, using the same helper and a fixed slot count; sequential
  computation is allowed only because the slot count and key length are fixed, and an
  implementation may compute them in parallel if it preserves the same observable
  behavior. For every request that reaches signature verification, the receiver
  performs equal-length constant-time comparisons for every slot regardless of match
  or mismatch, converts each slot's `not_before`/`not_after` validity into a
  fixed-width mask, combines match bits and window masks with bitwise OR/result
  masking in a full-length loop, and rejects the entire request only after the full
  candidate set has been tested. It accepts only a masked match whose window mask is
  valid; no branch, log, replay lookup, or response decision may reveal which slot
  matched or whether a match failed only because its window was invalid. The required
  implementation pattern is
  `crypto.timingSafeEqual` or
  equivalent for each candidate, fixed-count loop iteration, no `some`/early
  `return`, no per-candidate exceptions, no per-candidate internal state in logs or
  traces until the loop completes, and tests showing equivalent behavior and bounded
  timing distributions when the matching secret is current, previous, dummy/absent,
  outside its validity window, missing, duplicated, malformed, too short, too long, or
  non-hex. The isolated receiver-artifact target is p95 delta <= 10 ms and p99 delta
  <= 25 ms between signature failure classes over at least 100,000 warmed samples,
  including strict signature parsing, the HMAC loop, replay-store read shape, and
  response-envelope floor. The production launch bound is
  derived from measured production-like baseline jitter with explicit headroom:
  initial managed launch may use at most p95 delta <= 75 ms and p99 delta <= 150 ms
  for the first week, then must tighten to the smaller of that ceiling or the measured
  baseline plus approved headroom once histograms prove the lower bound is stable.
  Production records the same histograms. Launch also requires a pre-production timing
  run against the production database schema, replay-store indexes, load balancer
  path, TLS termination, framework parser, quarantine tables, and synthetic row-present,
  row-absent, locked-row, malformed-header, current-secret, previous-secret, and dummy
  cases under representative CPU contention and load-balancer/TLS/framework load.
  Production sends low-rate synthetic signed probes
  for those classes, records five-minute p50/p95/p99/max deltas by class, and pages
  on-call on a single-window breach before the three-window fail-closed threshold. A
  single-window breach records the failing classes, alerts on-call immediately, and
  continues intake while preserving quarantine readiness. If drift exceeds the bound
  for three consecutive five-minute windows, the receiver automatically, without
  waiting for operator confirmation, enters verifier-quarantine mode: it continues raw
  verification and replay reads for
  signed deliveries, durably quarantines verified review/command and
  authorization-control events, blocks job processing, blocks new job claims and
  decrypts for affected scopes, and reconciles installation/repository/permission
  state from GitHub before processing resumes. If the receiver cannot verify and
  persist to quarantine, the system globally fails closed by blocking hosted job claims
  and decrypts until reconciliation completes; it does not rely on GitHub redelivery as
  the only preservation mechanism. Operators can re-enable job processing only after
  documenting whether the cause was load jitter, infrastructure drift, or verifier-code
  drift; verifier-code drift requires rollback or a new passing launch timing run
  before processing resumes. The verifier module is static, has no dynamic code
  generation, and its timing tests run against the production bundle, but this is a
  remote timing mitigation, not a claim against local microarchitectural observation
  of the receiver process. Only after the full signature loop completes does the
  receiver consult the replay store. The replay decision receives the immutable
  match-bit set from that just-completed HMAC loop; replay-store state alone is never
  authentication. Replay-store access uses a fixed prepared read sequence for the
  current-secret key and previous-secret key, including `SELECT ... FOR UPDATE` for
  expected duplicate rows, before any branch-specific insert path can run. Row presence
  or absence is masked into the final decision after the fixed read sequence and fixed
  response floor; the design does not claim database planner constant time, and
  row-present/row-absent timing classes are part of the launch and production
  histograms above. Old-secret duplicate acceptance requires both the old-secret match
  bit for the exact immutable raw payload bytes just hashed and an existing
  pre-activation replay row. Delivery ids are recorded with a 24-hour replay TTL
  before enqueueing, keyed with installation id, repository id when present,
  delivery id, payload hash, action, and accepted secret version. The installation id
  is parsed from the signed payload before replay insertion and must match the row's
  tenant scope before any job or control event is enqueued. New replay rows may be
  inserted only for the current secret version
  or for the first accepted delivery before `new_secret_active_at`; an old-secret
  match during grace is never allowed to create the prior replay record it needs for
  acceptance. Planned rotation grace is redelivery-only: it accepts a delivery signed
  by the previous secret after activation only when that exact delivery was first seen
  and recorded before `new_secret_active_at`; a first-seen old-secret delivery after
  activation is intentionally rejected rather than establishing new authority for the
  retired secret. This is an explicit read-then-conditional-insert flow with no upsert:
  if the old-secret match has no existing pre-activation replay row, verification
  fails before any replay record is inserted and returns the same response envelope
  and fixed-path response generation as a current-secret HMAC mismatch. The old-secret
  replay-row miss path cannot branch, log, or respond on the miss reason until after
  the response is committed, and its timing class is part of the same launch and
  production histograms as current-secret mismatches. Current-secret first-delivery
  insertions run in a serializable transaction with a unique index over the replay key
  above; old-secret duplicate checks use `SELECT ... FOR UPDATE` on the existing
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

**Selected option:** the launch-safe default is a new managed GitHub App identity
whose private key was never distributed to Actions. Reusing the existing
`prowl-review` GitHub App identity is allowed only if GitHub provides deletion-grade
evidence for every Action-distributed private key version, as defined below; otherwise
reuse remains disabled and the managed service launches under the new App identity.
Existing summary markers continue to be recognized only when they were authored by the
authenticated `prowl-review[bot]` login or copied by the explicit migration job; that
job may read prior `github-actions[bot]` marked summaries and copy only their redacted
state marker into hosted review state, but it does not edit old comments. Check runs
remain tied to their original GitHub run ids and are not migrated; the App creates or
completes only its own `Prowl Review` check for the current head.

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
GitHub App private-key inventory from a GitHub API, audit export, or signed GitHub
support attestation that distinguishes deleted keys from merely disabled keys; manual
settings-screen captures are not sufficient for managed launch. The record must prove
that every Action-distributed key version is deleted from the GitHub App registration,
not only disabled, and must enumerate every current and historical installation id
known to Prowl before the cutoff. GitHub UI "inactive" states, best-effort audit logs
that do not distinguish disabled from deleted, and canary-only evidence never satisfy
this gate because they cannot prove a key is non-reenableable. If a documented GitHub
API/export is unavailable, the required evidence is a signed GitHub Security or
support attestation that names the App id, key ids/fingerprints, deletion time,
non-reenableable deletion semantics, and the attesting GitHub authority; absent that
attestation, managed launch must use the new App identity default. This design does
not assume GitHub currently exposes a public deletion-grade private-key inventory API;
the launch record for any reuse attempt must cite the exact GitHub-documented API,
export schema, or signed-attestation format used, and no unpublished/operator-only
claim can satisfy the automated startup gate. The canary signs a GitHub App JWT with
the sealed retired key material and calls GitHub's installation-token endpoint for all
installations when fewer than 10 exist, otherwise at least 3 installations spanning
different owners plus the controlled installation; only GitHub-origin
`401`/invalid-signature responses count as proof, while local preflight rejection,
network failure, or missing installation access is inconclusive and blocks launch.
The launch record must also audit repository workflows and organization/repository
secret metadata for known `PROWL_APP_PRIVATE_KEY` distribution paths; because GitHub
does not expose secret values, any organization whose secret inventory or workflow
usage cannot be audited is recorded as unverifiable and blocks reuse of the shared App
identity. The canary is supporting drift evidence, not a substitute for GitHub-level
key-list verification. The canary and key-inventory verification run in production
before opening external installs, at managed App startup, after any key rotation, and
monthly as a scheduled drift check that re-enumerates installations and samples
different owners; failure pages the on-call and immediately disables external
installation acceptance, hosted token minting, and review enqueueing for the managed
App until operators either repair the revocation evidence or migrate to a new App
identity. If GitHub-level revocation cannot be verified with high confidence, the
managed service must register and provision a new GitHub App identity whose private
key was never distributed to Actions; migration docs then map old Action markers to
the new bot only through the explicit marker-copy job above. The managed App signing credential
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
owns by fallback only when a fresh trusted-base read proves the owner field is absent,
no file matching `**/.github/workflows/*prowl-review*.yml` or
`**/.github/workflows/*prowl*.yml` exists in the trusted-base tree, and no other
workflow file contains a step using `prowl-tools/prowl-code-review@*`. Any present
Prowl workflow file, including disabled, skipped, broken, renamed, commented-out,
non-running, legacy, or v2 variants, counts as Action ownership ambiguity and cannot
trigger hosted failover. Workflow file detection cannot override an explicit config
owner and is re-run from the trusted base before claim; repos that want hosted failover
must set `delivery.owner: app` in trusted-base config rather than relying on workflow
failure detection.

Before hosted launch, the Action must learn this field from the same trusted-base
config it already loads and exit with a neutral "App owns delivery" result before
any provider call when `delivery.owner: app`. The hosted App performs the symmetric
check and no-ops when `delivery.owner: action`. Owner is read from the trusted base
ref/config generation associated with the PR head. The initial owner decision records
the trusted-base ref, config commit SHA, config blob SHA, owner value, and lifecycle
generation. Owner changes apply only to the next PR head SHA or base-config
generation; they increment lifecycle generation and supersede in-flight work for older
generations. Subsequent deliveries for existing PR heads re-query the owner before
enqueueing; in-flight reviews under the previous owner are marked `config_changed` or
superseded and stopped before provider calls and before publication if ownership
changed. The runner also re-reads the trusted-base config immediately before claiming
a job, before provider calls, and before publication; if the base ref now points at a
different config commit/blob than the recorded generation, the review never silently
adopts the new owner mid-flight. It transitions to `config_changed`, publishes at most
one clear skipped/superseded status under the original generation when allowed, and
requires a new delivery under the new generation for more work. Cache expiry or
mismatch produces the same unclear-owner skip. The cached owner in the hosted store is
only a UI hint. The idempotency key includes the owner and lifecycle generation:
`{installation, repository, pull_request, head_sha, owner, base_config_ref,
base_config_commit_sha, base_config_blob_sha, lifecycle_generation}`, and both
delivery paths re-check the owner before provider calls and publication. This
Action/App owner check is a launch blocker for dual-delivery support.

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
   permission cache may suppress repeated unauthenticated ingress noise only when it was
   minted from GitHub for the same `{installation, repository, sender, required_role}`
   within the last 60 seconds; it is never final authority for any current allowlisted
   command. Positive entries use a hard, non-sliding expiry, are evicted by a minutely
   sweeper, are dropped on process restart, and are never refreshed by cache hits. Every
   current command, including `help`, `review`, `full review`, `docstrings`, `tests`,
   chat replies, `pause`, `resume`, `configure`, `configure key`, `break glass`,
   `ignore`, and `resolve`, must perform a fresh GitHub API read before execution,
   provider calls, publication, or user-visible command output; a cache hit attempt on
   the final authorization path returns a sentinel failure, alerts, and aborts.
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
   policies; those commands must perform a fresh GitHub API read. The command registry
   carries an explicit `requires_fresh_auth`/`policy_sensitive` flag for admin,
   key-setup, provider-backed, state-changing, branch-protection-sensitive, and
   enterprise/SAML/IP-sensitive commands; launch tests fail if any such command can
   reach side effects from a positive cache hit. Unknown permission or enterprise
   policy webhooks also set an `enterprise_policy_dirty` flag that is cleared only by a
   successful full installation/org permission reconciliation; while set, sensitive
   commands bypass the cache and fail closed if GitHub cannot confirm current authority.
   Settings UI and
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
   with the locked row again inside guarded send after the read returns. The fresh
   GitHub permission API read runs with an explicit deadline, capped at the smaller of
   5 seconds or 20% of the remaining command deadline, and no database row lock is held
   while waiting on that network call. Timeout, cancellation, secondary-rate-limit, or
   ambiguous API failure reaches terminal `authorization_changed` or
   `authorization_unavailable` and writes no side-effect reservation. If a
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
   transaction, locks the installation auth row and command row, re-reads the current
   auth generation, and confirms it still matches the generation recorded before the
   GitHub API call was issued plus the authorized sender/role/scope. If the generation
   has advanced, the transaction rolls back immediately without consuming a
   provider-call nonce, writing a side-effect fencing token, creating a publication
   reservation, or opening an external request, and the command transitions to terminal
   `authorization_changed`. Only if the generation still matches does the helper
   consume any provider-call nonce or publication reservation, write a side-effect
   fencing token, commit, and then immediately open the external request in the same
   call stack without unrelated awaits, timers, or queue hops. The request builder
   requires that fencing token and performs one final local generation read before
   opening the socket; a webhook generation bump that lands between the API read and
   socket open either blocks on the same row lock or makes that final read fail. A
   revocation that occurs after the final local read but before the first outbound
   packet leaves the process remains a residual GitHub/event-delivery race, is bounded
   by the guarded-send telemetry in Decision 2, and is not claimed as atomic cancellation. State-changing,
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
   installations plus explicit write/config authority for the target repository's
   trusted-base `.prowl-review.yml` scope, repository `admin` permission for
   repo-only/user installations, or membership in the audited installation-admin
   allowlist maintained by those admins. For org installations, that org-owner check
   is evaluated before the repository write/config check. If the App installation has
   `Members: read` at the current grant version, the handler uses the App permission to
   read current org-owner status. If the App lacks that permission but the already
   authenticated settings/command session has OAuth `read:org`, the handler uses that
   session for the org-owner check. If neither authority is available, org key
   configuration fails closed with a clear GitHub App reapproval or OAuth
   reauthorization link, records which authority was missing, and does not create a
   settings nonce. Only after org-owner eligibility is confirmed does the handler read
   repository write/config authority for the target trusted-base `.prowl-review.yml`
   scope under the same current installation auth generation; a repository check cannot
   compensate for a missing org-owner authority. A one-time reapproval is never assumed
   to persist without re-checking the current installation permissions. A
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
   deployment or self-host instance id, installation id, repository id, PR number, and
   current head SHA match the idempotency record for the command. Before any provider
   call or side effect, the
   handler atomically claims an unconsumed command record keyed by those fields plus
   command verb and lifecycle generation, and marks it consumed in the same
   transaction. Already-consumed records are rejected even when the delivery id,
   comment id, body digest, and head SHA match. The edited timestamp is GitHub's
   `updated_at` value from a fresh GitHub API read, not a client-derived or
   webhook-trusted clock value. The body digest is SHA-256 over the exact raw UTF-8
   bytes of GitHub's REST/GraphQL `body` field as returned by that fresh API read,
   followed by fixed-length encodings of command parse version and verb; it is not
   rendered Markdown, trimmed text, Unicode-normalized text, line-ending-normalized
   text, or only the matched command fragment. Cosmetic edits, including trailing
   spaces or line-ending changes returned by GitHub, produce a different digest and
   therefore a different consume-once record after the comment-level lock. Webhook
   payloads may enqueue edit work but cannot create the canonical
   consume-once record. Edited comments create a distinct consume-once record keyed by
   the deployment/instance id, that API-read timestamp, and digest only after a
   comment-level execution lock keyed by
   `{deployment_id, installation, repository, pull_request, comment_id}` is available.
   After the lock is acquired, the handler performs the fresh GitHub API read that supplies the
   authoritative `updated_at` value, full body digest, parsed verb, and head SHA. If
   the API state no longer matches the queued delivery, the queued version is recorded
   as superseded without creating a consume-once record, and the latest queued edit is
   processed behind the same lock. While holding the lock, the handler allocates a
   monotonic local `comment_version_seq` for the current API state and inserts the
   consume-once row through a unique constraint over `{deployment_id, installation,
   repository, pull_request, comment_id, api_updated_at, body_digest, parse_version,
   verb}` plus the local sequence. `deployment_id` is the managed App deployment id or
   self-host instance id and is never inferred from GitHub installation id alone, so
   exported/imported records or shared-App migrations cannot make an independent
   deployment honor another deployment's consume-once row. Insert conflicts are
   treated as duplicates and do not execute again; identical
   `updated_at`/digest/verb values represent the same observed comment version, and
   different digests under the same GitHub timestamp serialize through the local
   sequence. The lock intentionally excludes the mutable parsed command verb, PR head
   SHA, and lifecycle generation so every edit of one comment serializes behind the
   same deployment-scoped comment identity. That lock is acquired before creating the
   consume-once row and held from claim through command terminal state, including
   provider calls and publication, with its own lease and fencing token. The handler
   fetches the current GitHub comment again immediately after acquiring the
   comment-level lock and before creating a consume-once row; if the GitHub-fetched
   `updated_at` value or body digest differs from the queued delivery, that queued
   version is recorded as superseded without a consume-once row and the latest queued
   edit is processed behind the same lock. Immediately before side effects, the handler
   repeats the current-comment read and aborts as superseded if the claimed version has
   advanced, recording the current version for later processing. Launch tests must show
   repeated API reads of the same edited comment produce the same digest, and cosmetic
   edits such as adding or removing trailing spaces produce a new digest and a new
   consume-once row only after the comment-level lock path above. If an
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
repository, sender, comment_id, comment_updated_at, body_digest, parse_version, verb,
args_digest, command_occurrence_id, head_sha, nonce}`, expires in 10 minutes,
is single-use, requires cache-bypassing
fresh GitHub OAuth/App authorization with the installation-admin definition above on
both settings GET and POST, and carries no key material in the URL. OAuth
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
auth-generation pattern above. Before the GitHub read starts, the handler records the
current installation auth generation from the database auth row. After the GitHub read
returns, nonce consumption plus key persistence must commit in one serializable
transaction that locks the nonce row and the same auth row, re-reads the current auth
generation under that lock, and compares it to the pre-read generation before
consuming the nonce. If the generation changed while the GitHub call was in flight,
the result is discarded as stale and no key candidate is persisted; there is no write
path that "adopts" the older generation after the lock is acquired. The transaction
uses the same database-clock expiry predicate plus nonce hash, session-binding hash,
sender id, OAuth user id, installation id, repository id, row version, locked auth
generation, and `consumed_at IS NULL`; a second request, different session, different
OAuth user, expired nonce, cache-hit authorization attempt, or permission-change
generation mismatch gets a generic used/expired or unauthorized response and cannot
write a key.
Settings GET and POST also compare the nonce row's `comment_updated_at`, body digest,
parse version, verb, args digest, command occurrence id, and head SHA against the
canonical consume-once command row created from the fresh GitHub comment read. Before
POST consumes the nonce, it re-reads the current GitHub comment and rejects the save as
`command_superseded` if the body digest, parse version, verb, args digest, command
occurrence id, or head SHA differs from the signed link. A missing, superseded,
edited, or differently parsed command row invalidates the nonce and requires a new
`configure key` command.

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
| Migration from the Action, App identity, delivery precedence, and commands | Launch-safe default is a new managed App identity; reuse `prowl-review` only with GitHub deletion-grade evidence for all Action-distributed private keys, trusted-base `delivery.owner`, and signed-webhook command authorization. | Prevents old Action-distributed signing keys or dual delivery from crossing into hosted custody while preserving an explicit marker-copy migration path. | Reuse without deletion-grade GitHub evidence, author-agnostic hidden markers, workflow-file-only precedence, sharing the managed App private key with Actions, and accepting commands from any mention. | Launch requires owner checks in both delivery paths, command replay/rate records, managed signing-key isolation, verified credential-rotation or new-App gate, and a settings flow for key configuration. |

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
