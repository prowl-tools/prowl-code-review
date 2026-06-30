# Data privacy

prowl-review is **BYOK and runs entirely on your own infrastructure** — your CI
runner (or your laptop, for local review) talks straight to the LLM provider you
chose, using the key you supplied. There is no prowl-review service in the middle.
This page states exactly where your code and keys go, and the protections applied
before anything leaves your runner. (backlog #40)

## The short version

- **We never see your code.** prowl-review is a CLI/Action that runs in *your*
  environment; there is no prowl-review server, account, or hosted endpoint.
- **We never see or store your key.** It is read from your environment and used to
  call your provider directly — never proxied through us, never persisted.
- **Your code only ever goes to _your_ chosen provider.** The diff and any
  cross-file context are sent from your runner to that provider's public API and
  nowhere else.
- **No telemetry, no analytics, no phone-home.** The only outbound network calls
  are to your LLM provider and the GitHub API.
- **Secrets are redacted and credential files skipped** before content is sent.

## Where your code goes

Inference requests go **directly from your runner to your provider's API** over
HTTPS, via a plain `fetch` — no intermediary, no prowl-review-hosted proxy:

| Provider | Endpoint your runner calls |
|---|---|
| Anthropic | `https://api.anthropic.com/v1/messages` |
| OpenAI | `https://api.openai.com/v1/chat/completions` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent` |

The only other outbound calls prowl-review makes are to the **GitHub API** (to
fetch the diff and post the review) and, *if you configure one*, a one-time fetch
of the **org-guidelines URL you specify** (`PROWL_ORG_GUIDELINES_PATH`). There are
no analytics or telemetry endpoints — you can confirm this by grepping the source:
the only network clients are the three provider modules and the GitHub Octokit
client.

## What leaves the runner (and what doesn't)

What is sent to your provider: the **size-guarded PR diff** and any **cross-file
context** the agentic retriever pulls (callers/definitions/related files) to ground
the review — after the protections below.

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

prowl-review retains **nothing** — it holds no database, no logs of your code, no
copy of your key. State that does persist (incremental-review markers, the
repo-wide learnings store) lives **in your own GitHub** as PR-comment markers and a
tracking issue in your repo (see backlog #12/#30), under your control.

What your provider retains is governed by **your account and your agreement with
that provider** — not by prowl-review. If you need zero-retention or
no-training guarantees, configure that on your provider account (most offer
enterprise/zero-retention API terms); because prowl-review uses your key against
your account, those terms apply to prowl-review's requests automatically.

## Why this beats hosted SaaS reviewers

Commercial reviewers proxy your code through their servers and resell inference,
which is why they must rate-limit and why your code transits a third party. With
prowl-review the trust boundary is just **you ↔ your provider**: no extra vendor
sees your code, no usage caps originate from us, and per-review cost is whatever
your provider charges (cents), billed to you directly.

## See also

- [`auth.md`](auth.md) — how keys are supplied and why subscription routing isn't.
- [`SECURITY.md`](../SECURITY.md) — vulnerability reporting + untrusted-PR handling.
