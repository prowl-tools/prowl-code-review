# prowl-review examples

Copy-paste starting points for adding prowl-review to a repository. These mirror
the recommended patterns from the [main README](../README.md).

## Quickstart (single provider)

1. Add your provider key as a repository secret named **`PROWL_AI_KEY`**
   (Settings → Secrets and variables → Actions). prowl-review is BYOK — the key
   stays in your repo's secrets and only ever talks to your chosen provider.
2. Copy [`workflows/prowl-review.yml`](workflows/prowl-review.yml) to
   `.github/workflows/prowl-review.yml` in your repo.
3. (Optional) Copy [`.prowl-review.yml`](.prowl-review.yml) to your repo root and
   tune it. The Action only loads it from a **trusted base-branch** checkout (see
   the `config-path` note in the workflow) — never from the PR's own code.
4. (Optional) Add [`workflows/prowl-review-command.yml`](workflows/prowl-review-command.yml)
   to drive the reviewer from PR comments (`@prowl-review review`, `pause`, …).
5. Open a pull request — prowl-review posts a walkthrough summary + inline
   comments.

## Branded bot identity (#59)

Want reviews to post as your own `prowl-review[bot]` with a custom avatar instead
of `github-actions[bot]`? Register a GitHub App, add `PROWL_APP_ID` /
`PROWL_APP_PRIVATE_KEY` secrets, and use
[`workflows/prowl-review-branded.yml`](workflows/prowl-review-branded.yml) (it mints
an App token and passes it to the Action). See the "Branded bot identity" section
of the [main README](../README.md).

## Org-wide rollout (one reusable workflow, #37)

Running prowl-review across many repos? Instead of copy-pasting the full workflow
into each one, define it **once** in your org's `.github` repo and have every repo
opt in with a few lines. See [`reusable/`](reusable/) for the `workflow_call`
templates + the tiny per-repo callers.

## Local pre-push review (no GitHub)

Run the same engine against a local diff before you push:

```bash
npm install -g prowl-review     # or: npx prowl-review …
PROWL_AI_KEY=sk-… prowl-review review --base main
```

## Ensemble (multiple providers)

To review with more than one model at once (e.g. Claude + Gemini), set
per-provider secrets (`PROWL_AI_KEY_ANTHROPIC`, `PROWL_AI_KEY_GEMINI`) and enable
the `ensemble` block in `.prowl-review.yml`. See the
["Multi-provider ensemble"](../README.md#multi-provider-ensemble-53) section of
the README.

## What a review looks like

See [`docs/example-review.md`](../docs/example-review.md) for a rendered sample of
the published walkthrough (summary + findings table + per-model sections).
