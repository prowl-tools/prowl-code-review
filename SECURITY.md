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
- Provider API keys are read from the **environment only** (`PROWL_AI_KEY` /
  `PROWL_AI_KEY_<PROVIDER>`) — never from `.prowl-review.yml`, never committed,
  never stored or proxied by us. Your key pays your provider directly.
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

### Configuration trust
- In the GitHub Action, `.prowl-review.yml` is only loaded from a trusted
  `config-path` (e.g. the base branch checkout), never from the PR's own
  checkout, so a contributor can't weaken review policy from their branch.

## Privacy & telemetry

- **prowl-review collects no telemetry and no analytics.** There is no usage
  reporting, no phone-home, no third-party tracking.
- The tool makes network calls to exactly two places: **your configured LLM
  provider** (to perform the review) and the **GitHub API** (to fetch the diff
  and publish the review). Your code and review content go only to the provider
  *you* chose with the key *you* supplied — never to us.
- Cost/usage figures are computed locally and written only to your run logs / the
  Action job summary / your local usage log — never transmitted.
- If telemetry is ever added, it will be **opt-in and off by default**, clearly
  documented, and never include code or secrets.

See also [data-privacy positioning](docs/backlog.md) (#40) for the broader stance.
