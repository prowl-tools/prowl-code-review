# Authentication & key policy

`prowl-review` is **BYOK — bring your own key**. You supply your own LLM provider
API key; prowl-review uses it to talk to that provider directly and never resells
inference, meters usage, or imposes its own rate limits. This page is the
authoritative statement of how prowl-review authenticates — to your LLM provider
and to GitHub — and which auth methods are supported vs. deliberately not.
(backlog #38)

## TL;DR

- **Provider keys come from the environment only** — never from `.prowl-review.yml`,
  never committed to the repo.
- **Bring an API key for the metered providers** (Claude, OpenAI, Gemini). That is
  the supported default auth method.
- **We never store or proxy your key.** It goes from your runner straight to your
  chosen provider (see [`privacy.md`](privacy.md)).
- **Subscription / OAuth routing is _not_ supported** for Claude or Gemini — doing
  so violates their consumer terms and gets accounts banned, with **no Claude/Gemini
  equivalent, ever**.
- **`provider: codex` is the one exception** (backlog #45): a keyless provider that
  spawns the first-party `codex` CLI under your ChatGPT sign-in. It is **off by
  default, opt-in, and supported only on self-hosted / local infrastructure you
  control** — never on GitHub-hosted runners for public/open-source repos. See
  [Codex subscription provider](#codex-subscription-provider-45) below.

## Provider keys (BYOK)

prowl-review resolves the provider and key from environment variables, in this
order:

| Variable | Purpose |
|---|---|
| `PROWL_AI_PROVIDER` | Which provider to use: `anthropic` (default), `openai`, `gemini`, or `codex` (keyless — see below). |
| `PROWL_AI_KEY_<PROVIDER>` | Provider-scoped key, e.g. `PROWL_AI_KEY_ANTHROPIC`. **Preferred** — wins when set. Not used by `codex`. |
| `PROWL_AI_KEY` | Generic fallback key, used when no provider-scoped key is set. Not used by `codex`. |
| `PROWL_AI_MODEL` | Optional model override (otherwise the provider's default model). |

Resolution (`resolveProviderConfig`, `src/providers/index.ts`): the provider-scoped
key `PROWL_AI_KEY_<PROVIDER>` is used if present, otherwise `PROWL_AI_KEY`; if
neither is set the run fails fast with a message naming both variables. The
multi-provider **ensemble** (#53) reads each `PROWL_AI_KEY_<PROVIDER>` so several
providers can review at once.

Default models per provider: Anthropic `claude-haiku-4-5`, OpenAI `gpt-5.4-mini`,
Gemini `gemini-2.5-pro`, Codex `gpt-5.5` — each overridable with `PROWL_AI_MODEL`
(or a per-provider `model` in config).

### Keys never live in the repo

The `.prowl-review.yml` schema **only** carries non-secret *selection* (which
provider, which model). Keys are read from the environment, full stop — there is
no config field that accepts a key, by design. Keep keys in your CI secret store
(GitHub Actions secrets) or your shell environment for local runs.

## GitHub Action

In the Action, pass your key(s) as **secrets** through the `ai-key*` inputs:

```yaml
- uses: prowl-tools/prowl-code-review@v1
  with:
    ai-key: ${{ secrets.PROWL_AI_KEY }}            # generic, single-provider
    # or per-provider (ensemble):
    # ai-key-anthropic: ${{ secrets.PROWL_AI_KEY_ANTHROPIC }}
    # ai-key-openai: ${{ secrets.PROWL_AI_KEY_OPENAI }}
    # ai-key-gemini: ${{ secrets.PROWL_AI_KEY_GEMINI }}
```

How those inputs are handled (`action.yml`):

- Each `ai-key*` input is documented "Pass a secret" and is **exported to an env
  var only when non-empty** — a blank input is never exported, so it can't clobber
  a key already present in the runner environment.
- Keys are passed as environment variables to the CLI; they are **not written to
  disk** and GitHub's built-in secret masking redacts them from Action logs.

### Posting to GitHub

prowl-review posts the review with the standard **`GITHUB_TOKEN`** (the
`github-token` input, defaulting to `${{ github.token }}`). It needs
`pull-requests: write` and `issues: write` (and `checks: write` for the optional
merge gate). This is the auto-provisioned Actions token — no PAT or GitHub App is
required for the Action path. To post under a custom GitHub-App identity, supply
that app's token as `github-token` and set `bot-login` so update-not-duplicate can
find prowl-review's own prior comments.

### Fork pull requests

GitHub does not expose repository secrets to workflows triggered by fork PRs, so a
fork PR has no provider key. prowl-review handles this safely — a keyless run is
skipped rather than failing — and the recommended workflows additionally guard on
`head.repo.full_name == github.repository`. See the README "Fork pull requests"
section and [`SECURITY.md`](../SECURITY.md).

## Why API keys only — the subscription question

A common ask is "can I reuse my Claude Pro / ChatGPT / Gemini *subscription*
instead of buying API credits?" For Claude and Gemini the answer is policy, not
laziness — and there is **no equivalent for them, ever**:

- **Claude (Anthropic) — not supported.** The current
  [Anthropic Consumer Terms](https://www.anthropic.com/legal/consumer-terms)
  §3.7 allow automated access only through an Anthropic API key or explicit
  permission; otherwise they prohibit access through "automated or non-human
  means, whether through a bot, script, or otherwise." Reusing Claude
  subscription OAuth in a third-party tool is the non-API path and creates an
  account-ban risk. Use an Anthropic **API** key.
- **Gemini (Google) — not supported.** Google began enforcing against
  subscription-OAuth reuse in third-party tools (Feb 2026). Use a Gemini **API**
  key.

The precedent for the strict stance: third-party tools that wrapped consumer
subscription auth (e.g. the OpenClaw episode) drew account enforcement. For Claude
and Gemini, BYOK with real API keys is the supported, durable path — and because
you pay the provider directly, there are no prowl-review-imposed usage caps.

**Codex is the one exception**, on a materially different footing (below).

## Codex subscription provider (#45)

OpenAI ships a **first-party** non-interactive surface — the official `codex` CLI
(`codex exec`) signed in with ChatGPT — and OpenAI's pricing states that CLI usage
under ChatGPT sign-in draws from your plan allowance. That makes `provider: codex`
a legitimately supported way to run reviews against your ChatGPT subscription
instead of a metered key. It is deliberately narrow:

- **Keyless.** `codex` uses **no** `PROWL_AI_KEY*`. Authentication lives in
  `$CODEX_HOME` (default `~/.codex`) and is resolved by the `codex` binary from
  its own `codex login` session. prowl-review **spawns the official `codex`
  binary only** — it never calls an OpenAI/ChatGPT backend endpoint directly, and
  it **never reads, copies, or logs `auth.json`**.
- **Off by default, opt-in.** Nothing changes unless you set `provider: codex`
  (or `PROWL_AI_PROVIDER=codex`). Run `codex login` on the machine first; a missing
  or logged-out `codex` binary produces a clear "run `codex login` on this
  machine" error rather than a crash.
- **Self-hosted / local infrastructure only.** OpenAI's own CI/CD authentication
  guidance says, verbatim:
  **"Do not use this workflow for public or open-source repositories."**
  So `codex` is supported **only on infrastructure you control**
  — a self-hosted runner or your laptop — and **never on GitHub-hosted runners for
  public/open-source repos**, and the subscription login must live on that machine,
  never in GitHub Actions secrets. Private repos on a self-hosted runner are fine.
- **Never copy `auth.json` between machines or instances.** Refresh tokens are
  single-use; a copied file logs out whichever side refreshes second. Keep one
  `CODEX_HOME` per machine. When several runner instances share it, prowl-review's
  machine-wide advisory lock (`$CODEX_HOME/.prowl-review.lock`, on by default for
  `codex`) serializes `codex` runs so one `auth.json` only ever serves one stream
  at a time. See backlog #64 for the self-hosted runner rollout.
- **No Claude/Gemini equivalent, ever.** This exists only because OpenAI offers a
  sanctioned first-party CLI + plan-allowance path; Anthropic and Google do not,
  and their consumer terms forbid it.
- **Retrieval read boundary.** For cross-file context, `codex` runs
  `--sandbox read-only` **against your real repo root**, so its own shell can
  **read any file in the checkout** while exploring. prowl-review's sensitive-file
  refusal + secret redaction apply to the **bundle Codex returns** (what enters
  the review), not to what Codex may open on disk; the retrieval prompt asks it to
  skip `.env`/keys/credentials, but that is guidance, not a sandbox guarantee. If a
  repo holds secrets a Codex process must never read at all, don't use
  `provider: codex` for it. See [`privacy.md`](privacy.md).

Enable it in `.prowl-review.yml`:

```yaml
provider: codex            # keyless: no PROWL_AI_KEY* needed
# model: gpt-5.5           # default; failback ladder: gpt-5.6-terra -> gpt-5.5
# codex:
#   effort: low            # low | medium | high | xhigh (default low)
#   lock: true             # machine-wide serialization lock (default on)
```

Cost transparency reports **`$0.00 (ChatGPT subscription)`** while still showing
the token counts (usage-limit resilience is tracked in #65).

### Self-hosted runner setup (shape only)

To run `provider: codex` from CI, the subscription login lives on a **self-hosted
runner**, never in a GitHub secret. In shape (full detail in
[`self-hosted-runner.md`](./self-hosted-runner.md); secrets-bearing operational
steps in a private runbook):

- **Dedicated `CODEX_HOME` per host** with its own **`codex login --device-auth`**,
  **one login per host** — the machine-wide lock serializes multiple runner
  instances so a single login serves them all. **Never copy `auth.json`** between
  hosts or instances (single-use refresh tokens).
- **Runner service config:** the runner's **`.env`** sets `CODEX_HOME=…`, and its
  **`.path`** must include the `codex` binary directory (e.g. `/opt/homebrew/bin`)
  so `codex` is on `PATH` for the service. Node is provisioned by the Action's own
  `actions/setup-node` step; nothing else is assumed on the host.
- **Labels:** `[self-hosted, macOS, prowl-review]`, which the review/command jobs
  target; the fork-gating jobs stay on GitHub-hosted `ubuntu-latest`.
- **Registration scope:** organizations register **one org-level runner** in a
  restricted runner group; **personal accounts allow repository-level runners
  only**, so register **one runner per opted-in repo**. Private repos need no
  fork gate and adopt first.

## Local CLI

The same key resolution applies to local pre-push review — export the env var and
run:

```bash
PROWL_AI_KEY=sk-… prowl-review review --base main
```

With the keyless Codex provider, no key is needed — just be logged in
(`codex login`) on the machine:

```bash
PROWL_AI_PROVIDER=codex prowl-review review --base main
```

## See also

- [`privacy.md`](privacy.md) — where your code and keys go (and don't).
- [`SECURITY.md`](../SECURITY.md) — vulnerability reporting + the trust model.
