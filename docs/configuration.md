# Configuration

prowl-review is configured with a `.prowl-review.yml` file, validated against a
strict Zod schema — every level is `.strict()`, so a typo (`minSeverty`) is a
loud validation error rather than a silently ignored key. The file is entirely
optional: a repo with no config reviews with the documented defaults.

Precedence is **CLI flag > config file > built-in default**. For the provider,
the `PROWL_AI_*` environment variables still win over the file.

**Secrets never live here.** Provider API keys always come from `PROWL_AI_KEY` or
`PROWL_AI_KEY_<PROVIDER>` in the environment — see [Auth](auth.md). Only the
non-secret provider/model *selection* is configurable.

Scaffold a fully commented starter with everything switched off:

```bash
prowl-review init          # writes .prowl-review.yml in the current directory
```

> **Trust note (GitHub Action).** The Action ignores repo config unless you pass a
> trusted `config-path` (a base-branch checkout), so a PR author can't alter review
> policy from their branch. See [GitHub Action](github-action.md#trusted-config).

## Example

```yaml
provider: anthropic         # anthropic | openai | gemini | codex
# model: claude-sonnet-4-6  # requires provider (model names are provider-scoped)

review:
  minSeverity: minor        # drop findings below this severity
  minConfidence: 0.5        # drop low-confidence non-critical findings
  maxFindings: 25           # cap findings surfaced
  maxInlineComments: 20     # cap inline comments; overflow rolls into the summary
  verify: true              # skeptical false-positive verification pass
  verifyConfidence: 0.8     # findings at/above this confidence skip verification
  incremental: true         # on re-run, review only the delta since last review
  resolveThreads: true      # tidy fixed/settled threads on re-run
  rejustifyDisputed: true   # on "I disagree", defend or withdraw the finding
  repoLearnings: false      # persist ignore/resolve mutes repo-wide
  auto: true                # auto-review PR events (false = on-demand only)
  reviewDrafts: false       # also auto-review draft PRs

context:
  enabled: true             # agentic cross-file context retrieval
  maxRounds: 6
  maxFiles: 20

grounding:
  enabled: true             # feed linter/SAST results into the review
  semgrep:
    enabled: true
    config: p/default

suggestions:
  minConfidence: 0.8        # min confidence to offer a committable suggestion block

checkRun:
  enabled: false            # publish a "Prowl Review" row in the PR checks list
  # failOn: major           # fail the check at/above this severity (omit = informational)

ignore:
  - "**/*.md"               # globs excluded from review (replaces built-in defaults)
```

## Provider selection

| Key | Default | Purpose |
|---|---|---|
| `provider` | `anthropic` | `anthropic` \| `openai` \| `gemini` \| `codex`. |
| `model` | per-provider default | Model override. **Requires `provider`**, so model names stay provider-scoped. |
| `codex` | — | Codex-only knobs; see [Codex](#codex-block) below. |

Per-provider default models: Anthropic `claude-haiku-4-5`, OpenAI
`gpt-5.4-mini`, Gemini `gemini-2.5-pro`, Codex `gpt-5.5`. Any of them can be
overridden with `PROWL_AI_MODEL` or a config `model`.

### Codex block

`provider: codex` is **keyless** — it runs the review through your ChatGPT
subscription by spawning the first-party `codex` CLI (`codex login`), so per-review
marginal cost is **`$0.00 (ChatGPT subscription)`** and no `PROWL_AI_KEY*` is
needed. It is off by default, opt-in, and supported **only on self-hosted /
local infrastructure you control**: under GitHub Actions it runs iff
`RUNNER_ENVIRONMENT=self-hosted`, regardless of repository visibility, and a
GitHub-hosted runner is refused. The subscription login lives on the host and
**never** in a GitHub secret — `auth.json` is never read, copied, or placed in
CI. There is no Claude/Gemini equivalent.

```yaml
provider: codex             # keyless; no PROWL_AI_KEY* needed
# model: gpt-5.5            # default; failback ladder gpt-5.6-terra -> gpt-5.5
codex:
  effort: low               # low | medium | high | xhigh (default low)
  lock: true                # machine-wide serialization lock (default true)
```

| Key | Default | Purpose |
|---|---|---|
| `codex.effort` | `low` | Reasoning effort (`model_reasoning_effort`): `low` \| `medium` \| `high` \| `xhigh`. |
| `codex.lock` | `true` | Serialize `codex` spawns machine-wide via `$CODEX_HOME/.prowl-review.lock`, so one `auth.json` serves one stream at a time. Opt out only when a single instance owns the host. |
| `codex.timeoutMs` | `600000` (10 min) | Per-`codex exec` timeout in ms; a hung child is killed (SIGTERM → SIGKILL). Positive integer. |
| `codex.lockTimeoutMs` | `600000` (10 min) | How long to wait for the machine-wide lock before failing, in ms. Positive integer. |

Related environment variables (each overrides the config key of the same name; the
`codex:` block is strict, so the binary path and `CODEX_HOME` are environment-only):

| Env var | Default | Purpose |
|---|---|---|
| `PROWL_CODEX_EFFORT` | — | Overrides `codex.effort`. |
| `PROWL_CODEX_LOCK` | — | Overrides `codex.lock`. |
| `PROWL_CODEX_TIMEOUT_MS` | 600000 (10 min) | Overrides `codex.timeoutMs`. |
| `PROWL_CODEX_LOCK_TIMEOUT_MS` | 600000 (10 min) | Overrides `codex.lockTimeoutMs`. |
| `PROWL_CODEX_BIN` | `codex` on `PATH` | Explicit `codex` binary path, for runners without the user's `PATH`. |
| `CODEX_HOME` | `~/.codex` | Where the `codex` login lives; also where the lock file is created. |

When the subscription allowance is exhausted, prowl-review does **not** post a
half-review or a red check: the merge-gate check completes **neutral**
("Review skipped/incomplete") with a note naming the reason and the reset hint,
and a usage limit is never retried. Re-run with `@prowl-review review` once the
window resets. Full policy in [Auth](auth.md#codex-subscription-provider-45) and
[Self-hosted runner](self-hosted-runner.md).

## Review tuning

| Key | Default | Purpose |
|---|---|---|
| `review.minSeverity` | `minor` | Drop findings below this severity (`critical` \| `major` \| `minor` \| `trivial` \| `info`). |
| `review.minConfidence` | `0.5` | Drop non-critical findings below this confidence (0–1). |
| `review.maxFindings` | `25` | Cap findings surfaced. |
| `review.maxInlineComments` | `20` | Cap inline comments; overflow rolls into the summary (`0` = none inline). |
| `review.verify` | `true` | Skeptical false-positive verification pass. |
| `review.verifyConfidence` | `0.8` | Non-blocking findings at/above this confidence skip verification. |
| `review.incremental` | `true` | On a re-push, review only the delta since the last reviewed commit. |
| `review.resolveThreads` | `true` | Resolve no-longer-current/settled threads on re-run and honor human replies. |
| `review.rejustifyDisputed` | `true` | On "I disagree", the judge defends the finding in-thread or withdraws it. |
| `review.repoLearnings` | `false` | Persist `ignore`/`resolve` mutes across PRs — see [Repo-wide learnings](repo-wide-learnings.md). |
| `review.auto` | `true` | Auto-review PR events (`false` = on-demand only). |
| `review.reviewDrafts` | `false` | Also auto-review draft PRs. |

## Context, grounding, and suggestions

| Key | Default | Purpose |
|---|---|---|
| `context.enabled` | `true` | Agentic [cross-file context](cross-file-context.md) retrieval. |
| `context.maxRounds` | `6` | Max tool-use rounds. |
| `context.maxFiles` | `20` | Max distinct files the agent may read. |
| `grounding.enabled` | `true` | Run repo linters and feed results into the review — see [Grounding](grounding.md). |
| `grounding.semgrep.enabled` | `true` | Semgrep SAST runner (skips if not installed). |
| `grounding.semgrep.config` | `p/default` | Registry pack only (`p/…`, `r/…`, `auto`); repo paths and remote URLs are skipped. |
| `dependencyScan.enabled` | `true` | osv-scanner CVE scan when a dependency lockfile changes. |
| `dependencyScan.licenses.allow` | *(unset)* | SPDX allowlist; dependencies outside it are flagged. |
| `suggestions.minConfidence` | `0.8` | Min finding confidence to offer a one-click committable ` ```suggestion ` block. |

Workspace execution trust is deliberately **not** read from repo config — use
`--trust-workspace`, `PROWL_TRUST_WORKSPACE`, or the `trust-workspace` Action
input, and only for trusted checkouts.

## Specialists and risk tiering

| Key | Default | Purpose |
|---|---|---|
| `specialists.builtins.<key>` | all on | Toggle a built-in lens off. Keys: `correctness`, `security`, `performance`, `tests`. |
| `specialists.custom[]` | *(none)* | Up to 10 custom reviewers, each an extra LLM pass feeding the same judge/dedup. |
| `riskTiering.enabled` | `true` | Scale pass count + context to diff size; `false` always runs the full `standard` set. |
| `riskTiering.minimal.maxChangedLines` / `.maxFiles` | `30` / `2` | Upper bounds for the cheap `minimal` tier (both must hold). |
| `riskTiering.deep.minChangedLines` / `.minFiles` | `500` / `20` | Lower bounds for the thorough `deep` tier (either triggers it). |

A custom reviewer takes `key` (lowercase alphanumeric/hyphen; also the finding
category), optional `title`, a required `focus`, optional `avoid`, and optional
`severityFloor`. Keys may not collide with a built-in, and `lint` /
`requirements` are reserved. At least one specialist must remain enabled.

```yaml
specialists:
  builtins:
    performance: false
  custom:
    - key: compliance
      title: Compliance
      focus: "Flag changes that violate our internal RFC-1234 logging standard."
      avoid: "General style nits unrelated to the standard."
      severityFloor: major
```

## Gating and publishing

| Key | Default | Purpose |
|---|---|---|
| `checkRun.enabled` | `false` | Publish a branded **Prowl Review** check run — see [Check run](github-action.md#check-run). Needs `checks: write`. |
| `checkRun.failOn` | *(unset)* | Severity at/above which the check fails. Unset = informational `neutral`. |
| `approval.enabled` | `false` | Engage the approval rubric (map findings → a GitHub review event). Off = comment only. |
| `approval.requestChangesAt` | `critical` | Severity at/above which the review requests changes. |
| `approval.approveWhenClean` | `false` | Approve (not just comment) when nothing is at/above the threshold. |
| `approval.breakGlass` | `true` | Honor `@prowl-review break glass <head-sha>` from trusted authors. |
| `agentPrompt` | `true` | Append a copy-paste "Resolve with an AI agent" prompt to each finding. |
| `prDescription.enabled` | `false` | Write a PR description from the diff when the body is empty (never overwrites a human one). |
| `issueValidation.enabled` | `false` | Validate the PR against its linked issue's acceptance criteria. |
| `issueValidation.maxIssues` | `3` | Cap linked issues fetched per PR. |

## Cost, size, and resilience

| Key | Default | Purpose |
|---|---|---|
| `budget.maxTokens` | *(unset)* | Per-PR token ceiling. |
| `budget.maxUsd` | *(unset)* | Per-PR USD ceiling, converted to a token ceiling via the model's input rate. The tighter of the two wins. |
| `pricing.<model>` | built-in table | USD per 1M tokens: `{ input, output, cachedInput? }`. Overrides the built-in estimate table. |
| `diff.maxFiles` | *(unset — no cap)* | Max changed files reviewed; the rest are reported as skipped. |
| `diff.maxBytes` | *(unset — no cap)* | Max total diff bytes sent to the provider. |
| `ignore` | built-in defaults | Globs for generated/vendored files to skip. **Replaces** the defaults when set; `[]` ignores nothing. |
| `resilience.failback.enabled` | `false` | On sustained overload, retry with an older model of the same family before giving up. Never crosses providers. |
| `ensemble.enabled` | `false` | Review with multiple providers at once — see [Ensemble](ensemble.md). |
| `ensemble.providers[]` | *(none)* | `{ provider, model? }` entries; the first is the primary. Keys come from the environment. |
| `debug.enabled` | `false` | Write a structured JSONL run trace (prompts, context, findings per stage, cost). Secrets redacted. |
| `debug.path` | `.prowl-review/debug.jsonl` | Trace path, confined to the workspace. `--debug` and `PROWL_DEBUG` / `PROWL_DEBUG_LOG` take precedence. |

When a budget or size cap skips content, that is **reported in the review**, never
dropped silently.

## Per-PR overrides

Runtime overrides can be set on a single PR with
[`@prowl-review configure`](bot-commands.md) — they persist in the summary's state
marker and win over the config file for that PR only. The allowlist is
deliberately small: **`minSeverity`, `maxFindings`, and `verify`**. Anything else
replies with usage rather than silently weakening the review; `configure reset`
clears the overrides.
