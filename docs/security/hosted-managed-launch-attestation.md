# Hosted Managed Launch Attestation

**Status: NOT ISSUED.** The managed hosted GitHub App is not available today, and
this attestation has not been signed. External managed installations, key-save
traffic, and provider traffic remain blocked until this file is replaced with a
complete, reviewed launch attestation.

Before managed launch, this document must name and link the source commit used to
build the deployment, the immutable post-build artifact digest, an externally signed
deployment record, launch records, runtime feature-flag state, and evidence for:

- The selected key-ingestion implementation class: pinned N-API/libsodium, external
  hardened secret broker, or platform enclave/secret service.
- Startup self-tests for memory locking, no-swap, no-core-dump, no-debug/no-inspector,
  blocked process inspection, and explicit canary-buffer zeroing.
- Canary-injection results proving plaintext provider keys do not reach logs, errors,
  traces, queues, caches, persisted state, crash dumps, or process-inspection paths.
- The deployed KMS/HSM IAM policy classes for key-admin, runner-decrypt,
  rewrap/deletion, backup/restore, and break-glass identities; grant-separation and
  policy-drift test results; immutable KMS audit-delivery evidence; and a
  post-revocation decrypt-failure test proving revoked grants and compromised roots
  cannot decrypt or re-wrap tenant data keys.
- The deployment platform and the infrastructure controls that enforce swap,
  core-dump, debugger, crash-dump, and runner-isolation policy.
- The provider HTTP wrapper, canonical mock, equivalence harness, dependency
  provenance report, timing/drift thresholds, and provider-egress launch record.
- The webhook verifier implementation path, raw-header/body-limit receiver evidence,
  duplicate-header fixtures, malformed digest fixtures, replay-store schema, planned
  rotation tests, timing/drift histograms, and verifier-quarantine drill results.
- The managed GitHub App identity decision: either a new App registration whose
  signing key was never distributed to Actions, or deletion-grade GitHub evidence plus
  canary results proving every Action-distributed private key for a reused App
  registration has been removed from GitHub and cannot mint installation tokens.
- Evidence that managed install, migration, and first key-entry screens display the
  custody warning, require acknowledgement of the active policy version, and keep
  key-save/provider traffic disabled until this attestation matches the deployed
  artifact digest and signed deployment record.
- Two security-owner signatures from maintainers who did not author the relevant
  implementation and are not the production deployment approver.

The attestation must be re-verified at least annually and after any relevant runtime,
platform, dependency, KMS/HSM policy, key-ingestion, provider-wrapper, or observability
change. If the attestation is missing, stale, unsigned, or names artifacts that do not
match the deployed source commit, artifact digest, deployment record, and environment,
the managed App must fail closed for key-save and provider traffic. The launch gate
must not depend on a Git commit SHA embedded in this file to prove the contents of the
same commit; the signed deployment record and artifact digest are the runtime binding.
