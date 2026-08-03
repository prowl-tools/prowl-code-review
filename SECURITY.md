# Security Policy

**prowl-review** runs with access to your pull requests and your LLM provider
key, so we take its security model seriously. This document explains how to
report a vulnerability, what's supported, the tool's security/trust model, and
its privacy & telemetry stance.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab → **Report a vulnerability**
   ([Security advisories](https://github.com/prowl-tools/prowl-code-review/security/advisories/new)).
2. Describe the issue, affected version/commit, and steps to reproduce.

We aim to acknowledge a report within **5 business days** and to keep you updated
as we investigate and fix. Please give us a reasonable window to ship a fix
before any public disclosure. We're happy to credit reporters who want it.

## Supported versions

prowl-review is in early (`0.x`) development. Security fixes target the **latest
release / `main`**; please reproduce against the latest before reporting.

| Version | Supported |
| ------- | --------- |
| latest `0.x` / `main` | ✅ |
| older     | ❌ |

## Security & trust model

prowl-review is **BYOK** (bring-your-own-key) and designed to run on untrusted
pull-request content without leaking secrets or executing attacker-controlled code.

### Keys & secrets
- **Deployment-path boundary:** the CLI and GitHub Action never store provider keys;
  the proposed managed Hosted App is a pre-launch exception that would store
  per-installation encrypted key material and transiently process plaintext keys in
  Prowl-managed services. Treat migration from CLI/Action to the managed Hosted App as
  an explicit trust-model change, not a transparent security-equivalent upgrade.
- For the current CLI and GitHub Action, provider API keys are read from the
  **environment only** (`PROWL_AI_KEY` / `PROWL_AI_KEY_<PROVIDER>`) — never from
  `.prowl-review.yml`, never committed, never stored or proxied by us. Your key
  pays your provider directly.
- The proposed hosted GitHub App in
  [`docs/design/hosted-app.md`](docs/design/hosted-app.md) is the only planned
  exception to the environment-only rule. It may store provider keys only as
  per-installation envelope-encrypted ciphertext, with the wrapping key outside
  the database and queues. Provider IAM/HSM policy, infrastructure-as-code policy
  tests, provider-side KMS audit logs, and drift alerts enforce separation between
  KMS administration, database administration, backup/restore, deletion workers,
  and runner decrypt identities. This protects stored ciphertext, queues, and
  backups. Decrypt permission scoped to an active runner job means that runner can
  decrypt only its current installation key while the job is active; a compromised
  active runner can still exfiltrate that plaintext key during the provider call.
  This is a material change from the CLI/Action model: in CLI/Action use, the
  plaintext key is exposed to the user's local machine or chosen GitHub runner and
  then to the selected provider, but not to a Prowl-hosted settings or runner process.
  In the managed Hosted App, Prowl-managed infrastructure receives the key during
  settings save/rotation, stores encrypted key material, and later decrypts it
  transiently for reviews. During key ingestion and save, Prowl-managed Node.js
  settings workers hold plaintext provider keys in process memory before encryption;
  a compromised settings worker, malicious npm dependency, active host debugger, or
  platform actor with access to that process memory can exfiltrate the plaintext key.
  The at-rest controls
  limit database-only, queue-only, backup-only, and KMS-unauthorized operator access;
  they do **not** protect a plaintext provider key from active service/runtime
  compromise while the key is being handled. Examples include runtime process
  inspection, a malicious dependency in the settings/runner/HTTP-client path, a
  host debugger, CPU or memory side channels, supply-chain compromise of the live
  service, or a platform/operator actor with access to active process memory. This
  is pre-detection exposure: incident response and revocation can reduce future
  decrypts, but they cannot undo plaintext disclosure that happened before the
  compromise was detected. Users who require "no Prowl infrastructure ever handles
  my key" or otherwise assume zero trust of Prowl-managed infrastructure must use
  the CLI, Action, or self-hosted App. Migrating from CLI/Action to the managed
  Hosted App is therefore an explicit opt-in to a weaker live-key custody model in
  exchange for install-once hosted operation; hosted migration docs and setup UI must
  show that warning before key entry. It also cannot protect against compromise,
  logging, or policy choices inside the user's selected LLM provider after the
  key/content is sent to that provider; provider key scoping, spend limits,
  monitoring, and rotation remain the user's provider controls.
- Hosted App revocation is an ordered, fenced sequence. The application database
  transaction marks the installation revoked, bumps the revocation generation,
  invalidates outstanding leases/fencing tokens, and prevents new job claims. After
  that commit, the control plane disables active KMS decrypt grants, cancels queued
  jobs, evicts caches, cancels active provider HTTP streams, and terminates active
  runners with graceful-then-hard deadlines. Runners must re-check revocation and
  fencing immediately before every provider or GitHub call and before publication;
  stale fencing tokens are rejected, never accepted as authority. Guarded provider
  sends decrypt, constructs credential-bearing headers, and hands the request to the
  HTTP client in the same guarded call stack without unrelated awaits, with staging
  telemetry required to keep the check-to-send handoff under a published
  millisecond-scale budget. A revocation that lands after that final check but before
  the provider receives the request is still an unavoidable cross-system race. A provider request
  already sent cannot be recalled; it may consume provider quota, reach the provider,
  continue server-side after the local stream is aborted, and expose the provider key
  in the request authorization material plus PR content to provider-side systems.
  Once that request reaches the user's selected provider, provider logging, caching,
  downstream transmission, endpoint compromise, or provider-side key misuse is
  outside Prowl's control and is not undone by Prowl revocation; users must rely on
  provider-side key scoping, spend limits, monitoring, and rotation for that boundary.
  If revocation happens in flight, the runner must re-check
  before parsing the provider response and again immediately before each GitHub
  publication call, then discard response bytes without extraction, summary
  generation, persistence, or GitHub publication if revocation is observed. Discard
  means the application does not parse, summarize, persist, or publish the response;
  bytes already received may still have existed in kernel, TLS, or HTTP-library
  buffers and, in runner memory, are bounded by the hosted HTTP wrapper's 64 KiB
  reader limit before process recycle. That live-buffer exposure is accepted residual
  risk, not a revocation guarantee. There is
  no true atomicity across the database and an already-started external GitHub API
  call. On uninstall or key deletion, hosted stores revoke the installation and delete
  live key rows, queued jobs, caches, and review state through the control-plane
  deletion flow; only encrypted backup copies of deleted key material and operational
  records remain until the published 30-day backup-expiry schedule. Incident timers
  start at detection time, defined as the moment an automated control or operator
  first classifies a scoped grant, wrapping key, audit stream, or policy state as
  suspect, not when revocation processing later succeeds. Suspected scoped
  compromise must block new job claims and alert operators within 5 minutes; broad
  or critical wrapping-key compromise must freeze all affected managed decrypts
  within 15 minutes. In either case, active runners for affected installations are
  terminated immediately with a 30-second hard deadline, queued work is cancelled,
  and affected installations stay suspended until data keys are re-wrapped or
  destroyed. Those incident timers are post-detection containment for future
  decrypts and stored ciphertext; they cannot undo plaintext exposure before
  detection, from a live compromised runner, or from a provider request that was
  already sent. The hosted App is not approved to launch until those controls exist
  and leak tests confirm decryption fails after revocation.
- Managed Hosted App custody controls are not user-verifiable until Prowl publishes
  evidence for them. These audit export, attestation, and audit-packet artifacts do
  not exist for users today and are pre-launch requirements, not current production
  guarantees. Before managed launch, Prowl must provide installation-admin audit
  exports for key create/update/delete, decrypt grant creation/denial,
  revocation, deletion, staff access, and incident containment events; a public
  control attestation naming the deployed KMS/HSM policy classes, launch-record
  commits, and latest drift-test status; and a documented process for installation
  admins to request an installation-scoped security audit packet after suspected key
  compromise. That packet must include redacted KMS grant/audit decisions, relevant
  app audit events, incident timeline timestamps, containment-deadline evidence, and
  the final remediation state. The managed App should not be marketed as
  independently audited until a third-party report or comparable compliance artifact
  exists; users who require independently verifiable custody controls before that
  report must self-host.
- The GitHub Action uses the auto-provisioned, least-privilege `GITHUB_TOKEN`
  (typically `pull-requests: write`, `issues: write`, optional `checks: write`).
- **Secret redaction (#15):** diffs, context, titles, issue text, and linter
  output are scrubbed of obvious secrets (API keys, tokens, private keys,
  `.env`-style assignments) *before* they reach a provider or a comment, and the
  redaction count is reported. Files that are sensitive by nature (`.env`, keys,
  credentials) are excluded from prompts entirely.

### Untrusted input
- All PR-derived content (diff, title, body, linked-issue text, linter findings)
  is treated as **untrusted data**, not instructions. Prompts frame it explicitly
  so prompt-injection attempts in a PR don't redirect the reviewer.

### Code execution & fork PRs
- Repo-local linters/formatters do **not** execute the checked-out code by
  default. Running them against a workspace requires the explicit
  `--trust-workspace` flag / `PROWL_TRUST_WORKSPACE` env / `trust-workspace`
  Action input, and that trust is **force-disabled on fork PRs** regardless of
  the flag.
- **Fork PRs (#20):** GitHub does not share secrets with fork `pull_request`
  runs, so a keyless fork review is **skipped with a clear message** instead of
  failing. On a fork, `.prowl-review.yml` is **not** auto-discovered from the
  (untrusted) checkout — only an explicit, maintainer-set `config-path` from the
  trusted base is honored. To review fork PRs deliberately, use a
  `pull_request_target` workflow (trusted base config; PR head used only as
  untrusted context). See the README's "Fork pull requests" section.
- The proposed managed hosted App keeps the same conservative default: v1 skips
  fork-originated PRs before retrieval or provider calls. Any future hosted
  fork-review opt-in requires a separate design update.

### Configuration trust
- In the GitHub Action, `.prowl-review.yml` is only loaded from a trusted
  `config-path` (e.g. the base branch checkout), never from the PR's own
  checkout, so a contributor can't weaken review policy from their branch.

## Privacy & telemetry

The no-telemetry guarantee below applies to the CLI, GitHub Action, and
self-hosted modes. The two-endpoint guarantee applies only to the CLI and GitHub
Action. Self-hosted hosted-App deployments may also call operator-selected queue,
database, KMS/HSM, storage, and observability endpoints; those endpoints are under
the self-host operator's control, not Prowl's. The managed hosted App has a
separate operational boundary because it necessarily runs Prowl-managed queueing,
storage, audit, and runner services.

- In the CLI, GitHub Action, and self-hosted modes, **prowl-review collects no
  telemetry and no analytics.** There is no usage reporting, no phone-home, no
  third-party tracking.
- In the CLI and GitHub Action, the tool makes network calls only to **your
  configured LLM provider** (to perform the review) and the **GitHub API** (to
  fetch the diff and publish the review). Your code and review content go only to
  the provider *you* chose with the key *you* supplied.
- In CLI, GitHub Action, and self-hosted modes, cost/usage figures are computed
  locally or in the operator-controlled deployment and written only to run logs /
  the Action job summary / local or operator-controlled usage logs — never
  transmitted to Prowl.
- The proposed managed hosted GitHub App has different operational boundaries:
  it necessarily uses the hosted queue, installation database, audit log, KMS/HSM
  service, GitHub API, and the user's configured LLM provider. Its durable systems
  may store only the operational metadata described in
  [`docs/design/hosted-app.md`](docs/design/hosted-app.md). This no-content rule
  applies to every hosted store, including queues and shared caches: no raw diffs,
  review bodies, prompts, provider responses, API-retrieved content, or plaintext
  provider keys. Raw webhook request bytes and GitHub event payloads may exist
  transiently in receiver memory for signature verification/routing, and review
  content may exist transiently in active runner memory for the review currently
  being processed; neither may be persisted as durable content.
- If telemetry is ever added, it will be **opt-in and off by default**, clearly
  documented, and never include code or secrets.

See also [data-privacy positioning](docs/backlog.md) (#40) for the broader stance.
