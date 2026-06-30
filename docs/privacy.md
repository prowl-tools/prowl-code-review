# Data privacy

prowl-review is **BYOK and runs in your CI runner or local environment** — your
runner (or your laptop, for local review) talks straight to the LLM provider you
chose, using the key you supplied. There is no prowl-review service in the
middle. This page states exactly where your code and keys go, and the protections
applied before anything leaves your runner. (backlog #40)

## The short version

- **We never see your code.** prowl-review is a CLI/Action that runs in *your*
  environment; there is no prowl-review server, account, hosted endpoint, or
  provider proxy.
- **We never see or store your key.** It is read from your environment and used to
  call your provider directly — never proxied through us, never persisted.
- **Review prompt content goes to _your_ chosen provider.** The diff and any
  cross-file context are sent from your runner to that provider's public API, not
  through a prowl-review server or hosted proxy.
- **No telemetry, no analytics, no phone-home.** The primary outbound network
  calls are to your LLM provider and the GitHub API. Optional configured features
  can also fetch your org-guidelines URL, Semgrep registry rules, or OSV.dev
  dependency advisories as described below.
- **Secrets are redacted and credential files skipped** before content is sent.

## Where your code goes

Inference requests go **directly from your runner to your provider's API** over
HTTPS, via a plain `fetch` — no intermediary, no prowl-review-hosted proxy:

| Provider | Endpoint your runner calls |
|---|---|
| Anthropic | `https://api.anthropic.com/v1/messages` |
| OpenAI | `https://api.openai.com/v1/chat/completions` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent` |

Other outbound calls prowl-review can make:

- **GitHub API** — fetches the diff and posts the review.
- **Org guidelines** — if you configure `PROWL_ORG_GUIDELINES_PATH` as an
  `http(s)` URL, prowl-review fetches that URL once and treats the contents as
  untrusted prompt data.
- **Semgrep registry** — if Semgrep is installed and SAST grounding runs, the
  default `p/default` registry pack can be fetched from Semgrep's registry.
  Semgrep is invoked with metrics and version checks disabled, and repository
  source stays on the runner.
- **OSV.dev** — if `osv-scanner` is installed and a changed dependency file is
  scannable, dependency grounding can query OSV.dev for vulnerability and license
  data.

There are no analytics or telemetry endpoints, and prowl-review does not operate
an intermediate service for your code, key, or review traffic.

## What leaves the runner (and what doesn't)

What can be sent to your provider, depending on enabled features: the
**size-guarded PR diff**, any **cross-file context** the agentic retriever pulls
(callers/definitions/related files), configured **repo/org guidelines**,
**repo-wide learned patterns**, deterministic **grounding** results, linked-issue
**requirements** and `requirementsDiff`, the PR title for PR-description
generation, and the selected language/specialist labels. These are provider-bound
prompt inputs, not prowl-review telemetry, and they are sent only from your
runner to your selected provider — after the protections below.

Applied **before** anything is sent (`src/review/redact.ts`, wired through the
pipeline and the context retriever):

- **Secret redaction.** Detected secrets are replaced with `[REDACTED:<type>]` —
  private keys (RSA/DSA/ECDSA/ED25519), AWS access keys, GitHub tokens & PATs,
  LLM keys (`sk-…`), Google API keys, Slack tokens, JWTs, and `key=value`-style
  credential assignments. The **count** of redactions is surfaced in the review;
  the secret value itself is never logged.
- **Sensitive-file skipping.** Files that look like credential stores are never
  read into context at all: `.env*`, `*.pem`/`*.key`/`*.p12`/`*.pfx`/keystores,
  SSH private keys (`id_rsa`/`id_ed25519`/…), `.npmrc`/`.netrc`/`.pgpass`/
  `.htpasswd`, and `credentials`/`secrets` files and directories.
- **No silent drops.** When a guardrail skips a file or caps content, that's
  reported in the review rather than dropped silently.

Redaction is a strong, conservative safety net — not a substitute for keeping real
secrets out of your diffs — but it means an accidentally-committed token is
scrubbed before it can reach the provider.

## Data retention

prowl-review retains **nothing on a prowl-review server** — it operates no
database and keeps no hosted logs of your code or key. State that does persist
(incremental-review markers, the repo-wide learnings store) lives **in your own
GitHub** as PR-comment markers and a tracking issue in your repo (see backlog
#12/#30), under your control.

If you opt into debug tracing with `--debug`, `PROWL_DEBUG`, or config,
prowl-review writes a redacted JSONL trace in **your workspace** at the path you
choose (or `.prowl-review/debug.jsonl`). That file can include assembled prompts,
redacted code/context, and run metadata for troubleshooting. If you upload it as
a GitHub Actions artifact, retention is governed by your GitHub/artifact policy,
not by prowl-review.

What your provider retains is governed by **your account and your agreement with
that provider** — not by prowl-review. If you need zero-retention or
no-training guarantees, configure that on your provider account (most offer
enterprise/zero-retention API terms); because prowl-review uses your key against
your account, those terms apply to prowl-review's requests automatically.

## Why this beats hosted SaaS reviewers

Commercial reviewers proxy your code through their servers and resell inference,
which is why they must rate-limit and why your code transits a third party. With
prowl-review there is no extra inference vendor between you and your provider: no
prowl-review server sees your code, no usage caps originate from us, and
per-review cost is whatever your provider charges (cents), billed to you
directly.

## See also

- [`auth.md`](auth.md) — how keys are supplied and why subscription routing isn't.
- [`SECURITY.md`](../SECURITY.md) — vulnerability reporting + untrusted-PR handling.
