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
- **Bring an API key for every provider** (Claude, OpenAI, Gemini). That is the
  only supported auth method today.
- **We never store or proxy your key.** It goes from your runner straight to your
  chosen provider (see [`privacy.md`](privacy.md)).
- **Subscription / OAuth routing is _not_ supported** for Claude or Gemini — doing
  so violates their consumer terms and gets accounts banned. OpenAI/Codex is the
  only provider where a subscription backend could ever be offered, and only as a
  documented, off-by-default, legally-reviewed opt-in (backlog #45, not yet built).

## Provider keys (BYOK)

prowl-review resolves the provider and key from environment variables, in this
order:

| Variable | Purpose |
|---|---|
| `PROWL_AI_PROVIDER` | Which provider to use: `anthropic` (default), `openai`, or `gemini`. |
| `PROWL_AI_KEY_<PROVIDER>` | Provider-scoped key, e.g. `PROWL_AI_KEY_ANTHROPIC`. **Preferred** — wins when set. |
| `PROWL_AI_KEY` | Generic fallback key, used when no provider-scoped key is set. |
| `PROWL_AI_MODEL` | Optional model override (otherwise the provider's default model). |

Resolution (`resolveProviderConfig`, `src/providers/index.ts`): the provider-scoped
key `PROWL_AI_KEY_<PROVIDER>` is used if present, otherwise `PROWL_AI_KEY`; if
neither is set the run fails fast with a message naming both variables. The
multi-provider **ensemble** (#53) reads each `PROWL_AI_KEY_<PROVIDER>` so several
providers can review at once.

Default models per provider: Anthropic `claude-haiku-4-5`, OpenAI `gpt-5.4-mini`,
Gemini `gemini-2.5-pro` — each overridable with `PROWL_AI_MODEL` (or a per-provider
`model` in config).

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
instead of buying API credits?" The answer is policy, not laziness:

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
- **OpenAI/Codex — the only possible exception, and not yet built.** A Codex
  subscription backend is tracked as an explicitly opt-in, off-by-default,
  legally-reviewed feature (backlog #45). It is **blocked until documented
  Legal/Compliance sign-off**, would rely on subscription auth that is
  tolerated-but-not-sanctioned (against OpenAI's reverse-engineering clause), is
  liable to break or trigger enforcement, and is **not recommended for automated
  org-wide CI**. It would be isolated behind the provider abstraction so it can be
  removed cleanly, would never be the default, and has **no equivalent for
  Claude/Gemini**.

The precedent for the strict stance: third-party tools that wrapped consumer
subscription auth (e.g. the OpenClaw episode) drew account enforcement. BYOK with
real API keys is the supported, durable path — and because you pay the provider
directly, there are no prowl-review-imposed usage caps.

## Local CLI

The same key resolution applies to local pre-push review — export the env var and
run:

```bash
PROWL_AI_KEY=sk-… prowl-review review --base main
```

## See also

- [`privacy.md`](privacy.md) — where your code and keys go (and don't).
- [`SECURITY.md`](../SECURITY.md) — vulnerability reporting + the trust model.
