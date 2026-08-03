# Hosted Managed Launch Attestation

**Status: NOT ISSUED.** The managed hosted GitHub App is not available today, and
this attestation has not been signed. External managed installations, key-save
traffic, and provider traffic remain blocked until this file is replaced with a
complete, reviewed launch attestation.

Before managed launch, this document must name and link the exact deployed commit,
launch records, and evidence for:

- The selected key-ingestion implementation class: pinned N-API/libsodium, external
  hardened secret broker, or platform enclave/secret service.
- Startup self-tests for memory locking, no-swap, no-core-dump, no-debug/no-inspector,
  blocked process inspection, and explicit canary-buffer zeroing.
- Canary-injection results proving plaintext provider keys do not reach logs, errors,
  traces, queues, caches, persisted state, crash dumps, or process-inspection paths.
- The deployment platform and the infrastructure controls that enforce swap,
  core-dump, debugger, crash-dump, and runner-isolation policy.
- The provider HTTP wrapper, canonical mock, equivalence harness, dependency
  provenance report, timing/drift thresholds, and provider-egress launch record.
- Two security-owner signatures from maintainers who did not author the relevant
  implementation and are not the production deployment approver.

The attestation must be re-verified at least annually and after any relevant runtime,
platform, dependency, KMS/HSM policy, key-ingestion, provider-wrapper, or observability
change. If the attestation is missing, stale, unsigned, or names artifacts that do not
match the deployed commit, the managed App must fail closed for key-save and provider
traffic.
