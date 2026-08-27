# Multi-provider ensemble

Review the same changes with more than one model at once (e.g. Claude + Gemini)
and merge the results — a BYOK-only edge, since resale-based reviewers can't
afford to run your diff through two models. Each provider runs the full
multi-pass review **in parallel**; a judge consolidates and de-duplicates the
findings into one clean result, marking findings that **≥2 providers
independently raised** with a 🤝 consensus badge. Opt-in, default off.

## Enable it

Give each provider its own key and list the providers in config:

```yaml
# .prowl-review.yml
provider: anthropic        # primary (also runs the shared context pass)
ensemble:
  enabled: true
  providers:
    - provider: anthropic
    - provider: gemini
      # model: gemini-2.5-pro   # optional per-provider model override
```

Locally, set the scoped env vars (the provider matching your primary also falls
back to `PROWL_AI_KEY`; the scoped key wins when both are set):

```bash
PROWL_AI_KEY_ANTHROPIC=sk-ant-…
PROWL_AI_KEY_GEMINI=…
```

In the GitHub Action, pass them through the per-provider inputs:

```yaml
- uses: prowl-tools/prowl-code-review@v1
  with:
    ai-key-anthropic: ${{ secrets.PROWL_AI_KEY_ANTHROPIC }}
    ai-key-gemini:    ${{ secrets.PROWL_AI_KEY_GEMINI }}
    # ai-key-openai:  ${{ secrets.PROWL_AI_KEY_OPENAI }}
    config-path: prowl-review-config/.prowl-review.yml   # trusted base-branch config
```

The keyless `codex` provider can also take part in an ensemble alongside API-key
providers — subject to the same self-hosted-only restriction described in
[Auth](auth.md#codex-subscription-provider-45).

## How it merges

The first configured provider is the **primary** — it runs the shared cross-file
context retrieval, and the linters run once too, so context and grounding are
gathered a single time and reused by every provider. Put your strongest model
first.

A judge then consolidates findings across providers, records provenance, and
**boosts confidence on agreement** — agreement can even rescue a finding each
provider scored just under the threshold, which complements the false-positive
verification pass. Consolidated findings carry a **🤝 N/M consensus badge** in the
summary and an inline note naming the agreeing providers; single-provider
findings are kept and attributed to the model that raised them.

The walkthrough leads with the consolidated, deduped table, then a **Per-model
findings** area with one collapsible section per provider, listing that model's
findings in its own words and severity. Inline comments additionally keep a
collapsible **🔀 N model perspectives** block when models agree on a line — so you
get the high-signal consensus *and* each model's distinct take, in one place. See
[Example review](example-review.md).

## Cost and fallback

Cost is roughly **N× a single-provider review** (caching helps within each
provider, not across). The per-PR budget cap is **split evenly** across providers,
and risk tiering still applies.

A provider missing its required credentials is skipped with a note. The keyless
`codex` provider is usable without an API key under the self-hosted/local
restriction described above. If fewer than two providers are usable, prowl-review
falls back to a normal single-provider review and says so in the review notes.
