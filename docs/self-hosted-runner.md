# Self-hosted runner setup (shape only)

How prowl-review runs keyless, subscription-backed reviews on a self-hosted
runner using `provider: codex` (backlog [#45](./auth.md#codex-subscription-provider-45) /
[#64](./backlog.md)). This page documents the **shape** of the setup — labels,
auth model, service config, registration scope. **Secrets-bearing operational
detail** (which account registers which runner, registration/group tokens, the
exact re-login steps) lives in a **private runbook**, never here.

> This is a reference, not a run book. Registering runners and logging in Codex
> happen on the host by an operator; nothing here should be executed by an agent
> against the machine.

## Why self-hosted

`provider: codex` is **keyless** — it spawns the first-party `codex` CLI signed
in with a **ChatGPT subscription**, so per-review marginal cost is `$0.00` and
**no provider credential ever enters GitHub**. That subscription login can only
live on infrastructure you control, so the reviews run on a self-hosted runner.
Under `GITHUB_ACTIONS=true`, prowl-review allows `codex` **iff the runner is
self-hosted** (`RUNNER_ENVIRONMENT=self-hosted`); a GitHub-hosted runner is
refused and a missing `RUNNER_ENVIRONMENT` fails closed. OpenAI's CI/CD-auth
guidance says not to use this workflow for public or open-source repositories,
so treat public/open-source CI as unsupported and use an API-key provider on
GitHub-hosted runners instead. For trusted private self-hosted workflows, keep a
**job-level same-repo + approved-actor gate** — a fork PR and an unauthorized
same-repo PR are never scheduled onto the runner unless an explicit owner-only
exception removes non-owner fork risk — and Codex itself runs
`--sandbox read-only`.

## Runner labels

Register each runner with the label set the workflows target:

```
[self-hosted, macOS, prowl-review]
```

The `review` / `command` jobs set `runs-on: [self-hosted, macOS, prowl-review]`.
The `prowl-review` label is registered with actionlint in
[`.github/actionlint.yaml`](../.github/actionlint.yaml) so the runner-label check
still catches typos. Fork-gating and neutral-check jobs stay on GitHub-hosted
`ubuntu-latest`, so a fork PR still gets a status row without touching the runner.

## Codex auth on the host

> [!WARNING]
> Codex runs `--sandbox read-only`, which prevents writes but still allows
> reading any file in the repo checkout during cross-file context retrieval. If
> a repo holds unignored secrets that Codex must never read, such as `.env`
> files or cloud credentials, do not use `provider: codex` for that repo. See
> [`docs/auth.md`](./auth.md#codex-subscription-provider-45) for the full
> boundary.

- **One dedicated `CODEX_HOME` per serialized session.** The normal setup is one
  `CODEX_HOME` per host (e.g. a path the runner user owns) with **`codex login
  --device-auth`** run there once. The device-auth flow keeps the login on the
  machine.
- **One login can serve every instance on the host when serialized.** When several
  runner instances share the host, prowl-review's machine-wide advisory lock
  (`$CODEX_HOME/.prowl-review.lock`, on by default for `provider: codex`)
  serializes `codex` runs so one `auth.json` only ever serves one stream at a
  time. If a runner instance needs an independent Codex session, give that
  instance its own `CODEX_HOME` and its own `codex login`; do not run separate
  logins against one shared `CODEX_HOME`.
- **Never copy `auth.json`** between machines or instances. Refresh tokens are
  single-use; a copied file logs out whichever side refreshes second. Re-login on
  each host instead.

## Runner service config

The runner's own service environment must expose Codex to the job:

- **`.env`** — set `CODEX_HOME=…` (the dedicated path above) so `codex` resolves
  the right login under the runner service.
- **`.path`** — must include the directory that holds the `codex` binary, e.g.
  `/opt/homebrew/bin` on Apple-silicon Homebrew, so `codex` is on `PATH` for the
  service (a login shell's `PATH` is not inherited by the runner service).

Nothing else is assumed on the runner: the Action provisions Node via its own
`actions/setup-node` step. Pin the `codex` CLI and `prowl-review` versions on the
host so a background upgrade can't change review behavior mid-flight.

## Registration scope

- **Repository-level runner per opted-in repo** — this is the selected topology
  for the live Prowl org repos and the only runner scope available to
  personal-account repos. Registration happens as the account that owns that
  repository.
- **Approved auto-review actors** — trusted private self-hosted auto reviews
  should run only for the owner or exact logins listed in
  `PROWL_REVIEW_ALLOWED_ACTORS` (repo/org variable). Keep the same-repo gate
  unless the workflow enforces an explicit owner-only exception. Keep command
  workflows' trusted-commenter association check as a separate gate.

All instances live on the same host with the shared `[self-hosted, macOS,
prowl-review]` label set. The runner user should be unprivileged with no access
to other secrets on the machine.

## Serialization

- **Per PR** — GitHub `concurrency` keyed by repo + PR number
  (`prowl-review-codex-<repo>-<pr>`) serializes auto reviews with
  `@prowl-review` commands for that PR. Keep `cancel-in-progress: false` so a
  newer auto-review push cannot cancel an in-flight maintainer command; if an
  older auto-review finishes after the PR head moves, the existing stale-head
  guard skips publishing outdated review content.
- **Machine-wide (across repos and instances)** — the **Codex lock**, not GitHub
  concurrency. GitHub cannot serialize across independent runner instances, so
  the lock is what guarantees one `codex` run at a time against one `CODEX_HOME`.

The review/command jobs set `timeout-minutes: 30`, sized for the dogfood's
`effort: low`; raise it when you raise `codex.effort` on large PRs, since higher
effort takes materially longer per run.

## Re-login runbook (shape)

When a Codex session is revoked or expires, re-run `codex login` on the affected
host (into its `CODEX_HOME`) to restore reviews — no GitHub change is needed. The
account-specific steps and any registration/group tokens live in the **private
runbook**. Never place the subscription login, `auth.json`, or a registration
token in a GitHub Actions secret or in this repo.

## See also

- [`docs/auth.md` → Codex subscription provider](./auth.md#codex-subscription-provider-45)
- [`examples/workflows/prowl-review-self-hosted-codex.yml`](../examples/workflows/prowl-review-self-hosted-codex.yml)
  and the command variant.
