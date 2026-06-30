# prowl-review

**BYOK (bring-your-own-key) AI code review for pull requests** — the code-review pillar of the [Prowl QA](https://prowl.tools) suite.

`prowl-review` reviews pull requests (summary + inline comments + `@prowl-review` chat) using your **own** LLM key — Claude (default), OpenAI, or Gemini — with **no usage caps imposed by us**. Because your key pays the provider directly, there's nothing to rate-limit: the only ceiling is your provider's own limits, which dwarf the per-hour caps of commercial reviewers.

It's delivered as a **GitHub Action + local CLI** (zero hosting), and is built to match — not just approximate — the quality of CodeRabbit/Greptile via agentic cross-file context, multi-pass specialized review, linter/SAST grounding, and false-positive verification.

> Status: **early development.** This package currently contains the project scaffold and CLI surface. See [`docs/backlog.md`](docs/backlog.md) for the roadmap and [`CLAUDE.md`](CLAUDE.md) for the design principles.

## Usage (GitHub Action)

Add a workflow that runs the review on pull requests. For single-provider
reviews, store your provider key as the `PROWL_AI_KEY` repository secret.

```yaml
# .github/workflows/prowl-review.yml
name: prowl-review

on:
  pull_request:
    types: [opened, synchronize, ready_for_review, reopened]

# Queue reviews and bot commands for the same PR so command side effects are not
# lost when new commits arrive. prowl-review re-checks the PR head before
# publishing and skips if it advanced, so queued stale reviews do not post.
concurrency:
  group: prowl-review-${{ github.event.pull_request.number }}
  queue: max
  cancel-in-progress: false

permissions:
  pull-requests: write   # post the review + inline comments
  issues: write          # create/update the summary comment
  checks: write          # optional merge-gate check run
  contents: read

jobs:
  review:
    # Forks don't receive provider secrets. Draft handling happens inside
    # prowl-review so review.reviewDrafts can opt into draft auto-reviews.
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # Optional: load Action config from the trusted base branch, not from PR code.
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.base.sha }}
          path: prowl-review-config
          persist-credentials: false
      - uses: prowl-tools/prowl-code-review@v1
        with:
          ai-key: ${{ secrets.PROWL_AI_KEY }}
          # config-path: prowl-review-config/.prowl-review.yml
          # ai-provider: anthropic   # optional anthropic | openai | gemini override
          # ai-model: claude-...     # optional per-provider model override
```

For ensemble reviews with provider-specific keys, omit `ai-key` and pass
`PROWL_AI_KEY_ANTHROPIC`, `PROWL_AI_KEY_OPENAI`, or `PROWL_AI_KEY_GEMINI` as
step env vars instead.

The `concurrency` block is the recommended pattern: keying the group to the PR
number serializes auto reviews with bot commands. `queue: max` and
`cancel-in-progress: false` preserve maintainer-requested side effects such as
`pause`, `resume`, and `break glass`; stale queued auto reviews skip publishing
when the PR head has advanced.

### Draft PRs & on-demand review (#28)

By default prowl-review **skips draft PRs** and reviews automatically once a PR
is marked *ready for review* (keep `ready_for_review` in the workflow's
`on.pull_request.types`). An explicit `@prowl-review review` reviews a draft
on demand. Two `.prowl-review.yml` keys tune this:

```yaml
review:
  reviewDrafts: true   # also auto-review drafts (default false)
  auto: false          # on-demand only: review just when asked with @prowl-review review (default true)
```

The Action ignores repo config unless a trusted `config-path` input is set. To
use these keys in CI, create `.prowl-review.yml` on the base branch, check out
that base branch to a separate path, and pass that path as `config-path` (for
example `prowl-review-config/.prowl-review.yml`). Do not point `config-path` at
the PR checkout; same-repo PR authors could alter review policy in their branch.
Keep draft handling out of the job-level `if`; a `draft == false` guard prevents
the Action from seeing drafts, so `review.reviewDrafts: true` cannot take effect.

When an auto review is skipped (paused, drafts, or `auto: false`) and the
merge-gate check is enabled, prowl-review posts a neutral check run so a Required
"prowl-review" check isn't left pending.

### Bot commands

Drive the reviewer from the PR by commenting `@prowl-review <command>` (only a
repo owner/member/collaborator is honored):

| Command | Effect |
|---|---|
| `@prowl-review review` | Re-review the latest changes (incremental). |
| `@prowl-review full review` | Re-scan the entire PR from scratch. |
| `@prowl-review ignore` | Reply on a finding to mute it — it won't be raised again on this PR (and repo-wide when `review.repoLearnings` is on) (#30). |
| `@prowl-review resolve` | Reply on a finding to mark its thread resolved and stop re-raising it (#26). |
| `@prowl-review configure <key=value …>` | Set per-PR review settings (`minSeverity`, `maxFindings`, `verify`); `configure reset` clears them (#26). |
| `@prowl-review pause` | Stop auto-reviewing this PR on new pushes. |
| `@prowl-review resume` | Re-enable auto-review. |
| `@prowl-review docstrings` | Draft docstrings for the changed code, posted as a copy-paste reply (#33). |
| `@prowl-review tests` | Draft unit-test stubs for the changed code, posted as a copy-paste reply (#33). |
| `@prowl-review help` | List the available commands. |
| `@prowl-review <question>` | Ask a free-form question — answered in-thread, grounded in the PR diff (#27). |

Anything after the mention that isn't a known command is treated as a question:
`@prowl-review why is this loop O(n²)?` gets a contextual reply in the same
thread. The starter below listens to top-level PR comments only; inline review
comments can be supported by also adding `pull_request_review_comment`, but each
inline comment creates a workflow run, so leave it out unless you need inline
questions or `ignore` replies.

**Code assists (#33).** `@prowl-review docstrings` drafts docstrings/doc-comments
for the functions, classes, and methods changed in the PR (in each file's
language convention); `@prowl-review tests` drafts unit-test stubs covering the
changed behavior, inferring the project's test framework from the diff. Both are
grounded in the (size-guarded, secret-redacted) PR diff and reply with
copy-paste-ready fenced code blocks — in-thread when invoked on an inline
comment, otherwise as a PR comment. They're suggestions to review before
committing, not auto-applied. Singular/`doc`/`docs` aliases are accepted.

**Replying to findings (#22).** Reply on a finding's thread and prowl-review
honors it on the next review: "won't fix" / "acknowledged" resolves the thread
and stops re-raising it. Reply **"I disagree"** (or "false positive", "not a
bug", …) and the judge actively **re-evaluates** the finding rather than silently
dropping it — it either **defends** it with reasoning in the thread (kept open,
still gates merge) or **withdraws** it, conceding and resolving the thread. Only
a repo owner/member/collaborator's reply is honored. Turn it off with
`review.rejustifyDisputed: false` (then a disputed finding is just withheld).

You can also reply **`@prowl-review resolve`** on a finding to mark its thread
resolved and stop re-raising it (like `ignore`, but it also closes the thread),
and **`@prowl-review configure minSeverity=major`** to set per-PR review settings
(`minSeverity`, `maxFindings`, `verify`) that apply on the next review;
`@prowl-review configure reset` clears them (#26). Per-PR settings are stored in
the summary's state marker and win over the repo config for that PR only.

**Repo-wide learnings (#30).** By default an `ignore` / `resolve` mute is scoped
to its PR. Set **`review.repoLearnings: true`** and the mute is also persisted to
a dedicated **`prowl-review: learned patterns`** tracking issue, so the same
finding is suppressed on **every** future PR — the OSS, BYOK equivalent of
CodeRabbit "learnings", with no external store. The issue lists each muted
pattern in plain text; **delete a line** (and re-run) to re-surface that finding,
or **close the issue** to clear the whole store. Only repo owner/member/
collaborator commands can teach it (same trust gate as every command), and the
write is best-effort — a failed issue write never blocks the per-PR mute.

**Guidelines & learned patterns (#30).** prowl-review injects repo guidelines
(`REVIEW_GUIDELINES.md` or `CLAUDE.md`) and a `LEARNED_PATTERNS.md` "do-not-raise"
file from the trusted checkout into every review. Set `PROWL_ORG_GUIDELINES_PATH`
to share one org-wide standard across repos — it accepts a **file path or an
`http(s)` URL** (host the file once and point every repo at it). The fetched
content is treated as untrusted prompt data just like a local file; a failed,
non-OK, or oversized fetch is skipped with a warning and the review proceeds.

```yaml
# .github/workflows/prowl-review-command.yml
name: prowl-review command
on:
  issue_comment:
    types: [created]
permissions:
  pull-requests: write
  checks: write
  issues: write
  contents: read
jobs:
  command:
    if: |
      github.event.issue.pull_request &&
      github.event.comment.user.type != 'Bot' &&
      (
        github.event.comment.author_association == 'OWNER' ||
        github.event.comment.author_association == 'MEMBER' ||
        github.event.comment.author_association == 'COLLABORATOR'
      ) &&
      contains(github.event.comment.body, '@prowl-review')
    concurrency:
      group: prowl-review-${{ github.event.issue.number }}
      queue: max
      cancel-in-progress: false
    runs-on: ubuntu-latest
    steps:
      - id: pr
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          pr_number="${{ github.event.issue.number }}"
          base_sha="$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${pr_number}" --jq '.base.sha')"
          head_sha="$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${pr_number}" --jq '.head.sha')"
          head_repo="$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${pr_number}" --jq '.head.repo.full_name')"
          echo "base_sha=${base_sha}" >> "$GITHUB_OUTPUT"
          echo "head_sha=${head_sha}" >> "$GITHUB_OUTPUT"
          if [ "${head_repo}" = "${GITHUB_REPOSITORY}" ]; then
            echo "trusted_head=true" >> "$GITHUB_OUTPUT"
          else
            echo "trusted_head=false" >> "$GITHUB_OUTPUT"
          fi
      - uses: actions/checkout@v4
        with:
          ref: ${{ steps.pr.outputs.base_sha }}
      - uses: actions/checkout@v4
        if: steps.pr.outputs.trusted_head == 'true'
        with:
          ref: ${{ steps.pr.outputs.head_sha }}
          path: pr-head
      - uses: prowl-tools/prowl-code-review@v1
        if: steps.pr.outputs.trusted_head == 'true'
        env:
          PROWL_REVIEWED_HEAD_SHA: ${{ steps.pr.outputs.head_sha }}
        with:
          mode: command
          ai-key: ${{ secrets.PROWL_AI_KEY }}
          config-path: .prowl-review.yml
          workspace-path: ${{ github.workspace }}/pr-head
```

## Fork pull requests (#20)

GitHub does **not** share repository secrets (your `PROWL_AI_KEY`) with workflows
triggered by `pull_request` from a **fork**, and the auto-provisioned
`GITHUB_TOKEN` is read-only there. prowl-review handles this safely:

- **Default — skip with a clear message.** On a fork PR with no provider key,
  prowl-review **skips cleanly** (no failure) instead of crashing on the missing
  key. The sample workflow's job-level
  `if: …head.repo.full_name == github.repository` already fences forks out; the
  tool-level skip is the backstop if that guard is removed.
- **No trust of fork code.** When prowl-review *does* run on a fork, the fork
  checkout is never trusted: repo-local linters/config don't execute
  (`--trust-workspace` is force-disabled), and `.prowl-review.yml` is **not**
  auto-discovered from the fork checkout — only an explicit, maintainer-set
  `config-path` (from the trusted base) is honored. Your key is only ever sent to
  your provider, never to fork code.

To **review fork PRs** anyway, run from a `pull_request_target` workflow, which
provides a write token and secrets while checking out the trusted base. Check out
the PR head to a separate path and pass it as `workspace-path` (context/grounding
only — still untrusted), and load config from the base:

```yaml
# .github/workflows/prowl-review-forks.yml
on:
  pull_request_target:
    types: [opened, synchronize, ready_for_review, reopened]
permissions:
  pull-requests: write
  issues: write
  contents: read
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4          # trusted base (config + guidelines)
      - uses: actions/checkout@v4          # untrusted PR head, for context only
        with:
          repository: ${{ github.event.pull_request.head.repo.full_name }}
          ref: ${{ github.event.pull_request.head.sha }}
          path: pr-head
          persist-credentials: false
      - uses: prowl-tools/prowl-code-review@v1
        with:
          ai-key: ${{ secrets.PROWL_AI_KEY }}
          config-path: ${{ github.workspace }}/.prowl-review.yml
          workspace-path: ${{ github.workspace }}/pr-head
```

> ⚠️ `pull_request_target` runs with secrets and a write token in the **base**
> repo's context. prowl-review never executes the fork's code, but you should not
> add other steps that run untrusted PR code in this workflow.

## Install (CLI)

```bash
npm install -g prowl-review     # or run ad hoc with: npx prowl-review …
# Homebrew:
brew install Prowl-qa/tap/prowl-review
```

npm and npx require Node.js >= 20; Homebrew installs node@20 automatically. The GitHub Action (above) needs no install.

## Local pre-push review (CLI)

Run the **same** review engine against a local git diff before you open a PR —
no GitHub token, no posting (#35). Findings print to the terminal:

```bash
# Review your branch's changes against main (tracked uncommitted edits included)
PROWL_AI_KEY=sk-… prowl-review review --base main

# Review the checked-out branch as an explicit head ref
PROWL_AI_KEY=sk-… prowl-review review --base main --head my-feature
```

The diff is taken relative to the **merge base** of `--base` and `--head` (PR
semantics — only the changes your branch introduces). Omit `--head` to review
the working tree. Untracked files are not part of Git's working-tree diff, so
local mode fails with a clear prompt to stage or commit them before review. When
`--head` is supplied, it must resolve to the currently checked-out `HEAD` and the
worktree must be clean; the later context, guidelines, grounding, and secret
scans read from that local checkout. Passing `--base` (or `--head`) switches the
`review` command into local mode; the GitHub flags (`--pr`, `--repo`,
`--dry-run`) are ignored.

| Flag | Effect |
|------|--------|
| `--base <ref>` | Base ref to diff against (default `main`). |
| `--head <ref>` | Checked-out head ref (default: the working tree). |
| `--min-severity <sev>` | Drop findings below this severity. |
| `--no-context` / `--no-grounding` / `--no-verify` | Skip cross-file context (#4), linter/SAST grounding (#16), or the false-positive pass (#8). |
| `--trust-workspace` | Allow repo-local linter/SAST code to execute. Without this or `PROWL_TRUST_WORKSPACE=true`, repo-local execution stays disabled. |
| `--json` | Print findings as JSON (for tooling) instead of the human report. |
| `--no-color` | Disable ANSI color (also honors `NO_COLOR`). |
| `--fail-on <sev>` | Exit non-zero when a finding at/above this severity is found — wire it into a pre-push hook as a gate. |

The same agentic cross-file context and safe linter/SAST grounding run over the
git repository top-level. Repo-local linter code executes only with
`--trust-workspace` or `PROWL_TRUST_WORKSPACE=true`; per-run cost prints to
stderr so `--json` stdout stays clean.

## Multi-provider ensemble (#53)

A BYOK-only edge: review the same changes with **more than one provider at once**
and consolidate their findings, so you get cross-model consensus and
higher-confidence, more granular insight — something resale-based reviewers
(CodeRabbit/Greptile) can't offer. Opt-in, default off.

Give each provider its **own** key — the cleanest setup, with no dependence on
which provider the generic key maps to. Locally (or any runner), set them as env
vars (the provider matching your primary also falls back to `PROWL_AI_KEY`; if
both are set, the scoped key wins):

```bash
PROWL_AI_KEY_ANTHROPIC=sk-ant-…
PROWL_AI_KEY_GEMINI=…
```

In the **GitHub Action**, pass them through the per-provider inputs (each maps to
the matching `PROWL_AI_KEY_<PROVIDER>` env var):

```yaml
- uses: prowl-tools/prowl-code-review@v1
  with:
    ai-key-anthropic: ${{ secrets.PROWL_AI_KEY_ANTHROPIC }}
    ai-key-gemini:    ${{ secrets.PROWL_AI_KEY_GEMINI }}
    # ai-key-openai:  ${{ secrets.PROWL_AI_KEY_OPENAI }}
    config-path: prowl-review-config/.prowl-review.yml   # trusted base-branch config
```

…and list the providers in `.prowl-review.yml` (the first listed provider is the
**primary** — it runs the shared cross-file context retrieval, so put your
strongest model there):

```yaml
provider: anthropic        # primary (also used for the shared context pass)
ensemble:
  enabled: true
  providers:
    - provider: anthropic
    - provider: gemini
      # model: gemini-2.5-pro   # optional per-provider model override
```

Each provider runs the full multi-pass review **in parallel**; the cross-file
context (#4) and linters (#16) run **once** and are shared. A judge then
consolidates findings across providers, recording provenance and **boosting
confidence on agreement** — agreement can even rescue a finding each provider
scored just under the threshold (it complements the false-positive pass, #8).
Consolidated findings carry a **🤝 N/M consensus badge** in the summary and an
inline note naming the agreeing providers; single-provider findings are kept and
attributed to the model that raised them.

**See what each model said.** The walkthrough leads with the consolidated,
deduped table (🤝 marks agreement), then a **Per-model findings** area with one
collapsible section per provider — Anthropic, Gemini, … — listing that model's
findings in its own words and severity. Inline comments additionally keep a
collapsible **🔀 N model perspectives** block when models agree on a line. So you
get the high-signal consensus *and* each model's distinct take, in one place.

**Cohesive review publishing.** The walkthrough is a single comment that's
**updated in place** on every push (not re-posted), and inline findings are
published as one GitHub `COMMENT` review with a `comments[]` batch. When the
approval gate (#52) sets an explicit Request-changes/Approve verdict, those
inline findings ride on that one verdict review.

**Cost:** roughly **N× a single-provider review** (caching helps within each
provider, not across). The per-PR budget cap (#18) is **split evenly** across
providers, and risk-tiering (#31) still applies. A provider with no key is
skipped with a note; with fewer than two usable keys it runs as a normal
single-provider review.

## Auto-generated PR descriptions (#33)

When a pull request is opened with an **empty description**, prowl-review can
write one from the diff — CodeRabbit-style — so reviewers get a plain-language
summary of what changed. Opt-in:

```yaml
# .prowl-review.yml
prDescription:
  enabled: true
```

The generated summary is written into the PR body between
`<!-- prowl-review:pr-summary:start -->` / `…:end -->` markers, so later pushes
refresh it in place while preserving anything you add around it. A
**human-authored description is never overwritten** — it only fires on an empty
body (or to refresh prowl-review's own block). Needs `pull-requests: write`
(already required to post reviews).

## Issue / ticket validation (#32)

When a PR **links a GitHub issue**, prowl-review pulls the issue's acceptance
criteria and flags anything the diff doesn't satisfy — so scope gaps are caught
in review. Opt-in:

```yaml
# .prowl-review.yml
issueValidation:
  enabled: true
  # maxIssues: 3   # cap linked issues fetched per PR (default 3)
```

It recognizes these PR references for issue validation: a **closing keyword**
(`Closes #12`, `Fixes owner/repo#5`) or an **issue URL** in the PR title/body. A
dedicated *requirements* review lens receives the issue's criteria and raises a
finding for each one the PR misses or only partially implements — so the gaps
appear inline alongside the normal review (and, in an ensemble, get cross-model
consensus too). Fetching is tolerant: a missing or inaccessible issue (or one
that's actually a PR) is skipped with a note. Cross-tracker support
(Linear/Jira) is a future extension.

## Semgrep SAST grounding (#16b)

Alongside ESLint (JS/TS), Ruff (Python), and Gitleaks (secrets), prowl-review
runs [Semgrep](https://semgrep.dev) over changed source files and feeds its
findings into the review as grounding — so the specialists reconcile with real
SAST results instead of re-discovering (or hallucinating) them. It's
multi-language and on by default, and **skips gracefully when Semgrep isn't
installed** — no failure, just a note.

**Ruleset sourcing.** By default it runs Semgrep's curated `p/default` registry
pack — the rules are fetched from the registry (cached after the first run, the
same network reach osv-scanner uses for OSV.dev) with **metrics disabled**, so no
project metadata is ever uploaded. That's why `--config auto`, which phones home,
is *not* the default. Only Semgrep registry refs (`p/…`, `r/…`, `auto`) are
supported. Repository-supplied rulesets (e.g. `.semgrep.yml`) and remote
`http(s)://` configs are skipped even on trusted workspaces, since a PR could
ship or point at a malicious/noisy ruleset.
For untrusted PR scans, repository `.gitignore` and `.semgrepignore` target
filters are bypassed, and symlink targets are skipped, so explicitly changed
regular files cannot hide from SAST grounding.

```yaml
# .prowl-review.yml
grounding:
  semgrep:
    enabled: true        # default; set false to disable
    config: p/default    # registry pack (p/..., r/..., or auto)
```

To use it in CI, make `semgrep` available on the runner (e.g. `pip install
semgrep` or the setup action). Without it, the rest of the review is unaffected.

**Resource bounds.** Linter/SAST grounding runs at most two tool runners at a
time. Gitleaks file scans and Semgrep invalid-target retries are also bounded
inside their runners, and every runner still honors the grounding file/finding
caps so large PRs do not fan out unbounded external processes.

## Dependency CVE / license scanning (#34)

When a pull request changes a dependency lockfile, prowl-review scans it with
[osv-scanner v2](https://github.com/google/osv-scanner) and surfaces **known
vulnerabilities** as findings (one per advisory, with the CVE id, affected
package@version, and the fixed version when available). It's part of the
deterministic grounding layer, so it runs by default and **skips gracefully when
osv-scanner isn't installed** — no failure, just a note. osv-scanner reads
lockfiles as data (it never executes your code), so it runs even on untrusted
checkouts. Repository-local `osv-scanner.toml` files are ignored for this scan so
untrusted PRs cannot suppress findings through scanner config.

Lockfiles are scanned even though they're excluded from line-by-line review by
the ignore list (#19) — the scan sources changed manifests from the full diff.
Supported ecosystems follow osv-scanner (npm, PyPI, Go, Cargo, Maven, Composer,
RubyGems, and more).

Set an SPDX **license allowlist** to also flag dependencies whose license falls
outside your policy:

```yaml
# .prowl-review.yml
dependencyScan:
  enabled: true                                  # default; set false to disable
  licenses:
    allow: [MIT, Apache-2.0, BSD-3-Clause, ISC]  # deps outside this list are flagged
```

To use it in CI, make `osv-scanner` available on the runner (e.g. a setup step
before the review). Without it, the rest of the review is unaffected.

## Suggested-fix validation (#39)

Findings can carry a committable ```suggestion``` block — a **one-click commit**
on GitHub. Because a wrong one breaks the build, prowl-review only offers that
block when it's confident in the fix:

- **Confidence floor** — only findings at/above `suggestions.minConfidence`
  (default `0.8`) get a committable suggestion. The proposed fix for a
  lower-confidence finding still appears in its "Resolve with an AI agent" prompt
  (#57); it just isn't a one-click commit.
- **Structural validation** — a deterministic, no-execution check drops a
  suggestion that's empty, a truncation placeholder (e.g. `// ...`,
  `// rest of the code`), or carries a leaked redaction marker, so a one-click
  apply never pastes obviously-broken code. (A valid suggestion may have
  unbalanced brackets — it replaces specific lines inside a block — so balance is
  never used to reject.)

Withheld suggestions are reported in the review notes (never dropped silently).

```yaml
# .prowl-review.yml
suggestions:
  minConfidence: 0.8   # raise to be stricter; lower to offer more one-click fixes
```

## Resilience (#17)

Transient provider blips (a 429, a 5xx, a dropped socket) are **retried with
exponential backoff + jitter** automatically. For *sustained* overload, opt into
**cross-generation failback**:

```yaml
# .prowl-review.yml
resilience:
  failback:
    enabled: true
```

When a review pass keeps failing with retryable/overload errors *after* retries
are exhausted, it retries with an **older model of the same family** (e.g.
`claude-opus-4-8` → `claude-opus-4-7`, `gemini-2.5-pro` → `gemini-2.5-flash`)
before giving up — so a degraded-but-real review beats a failed pass. It never
crosses providers (that's the ensemble's job) and never falls back on a
non-retryable error; each fallback is noted in the review.

Long review runs also emit a **heartbeat** to the Action log (`still
reviewing … (Ns elapsed)`) and log transient retries across specialist,
verification, and ensemble passes, so a slow review isn't mistaken for a hung CI
job.

## Debug / verbose mode (#49)

When a review behaves oddly, turn on a structured **JSONL run trace** to see what
the run actually did — the assembled prompts, the files context retrieval pulled,
the findings at each stage (raw → verified → judged), and the token/cost
breakdown. Secrets are redacted (#15), and the log is appended one line per
event in order without blocking review work on disk I/O.

```bash
# Local: write the trace to the default local state file (.prowl-review/debug.jsonl)
prowl-review review --base origin/main --debug

# …or to an explicit path
prowl-review review --pr 123 --debug traces/pr-123.jsonl
```

Equivalent config / env (the flag wins):

```yaml
# .prowl-review.yml
debug:
  enabled: true
  path: traces/run.jsonl   # optional; defaults to .prowl-review/debug.jsonl
```

```bash
PROWL_DEBUG=true PROWL_DEBUG_LOG=traces/run.jsonl prowl-review review --pr 123
```

In the GitHub Action, set the `debug: true` input and upload the trace with
`actions/upload-artifact` to inspect it after the run. The trace path is confined
to the workspace, rejects symlinked path components, and nested parent
directories are created automatically. Secure workspace-confined writes require
POSIX `O_NOFOLLOW` support; platforms that do not expose it fail closed rather
than following a possible symlink. Local review ignores prowl-generated
`.prowl-review/` outputs during clean-worktree checks so the default trace does
not block the next local review in repos that have not ignored that directory.

Each line is a `{ seq, t, event }` record (`t` = ms since the run started). Inspect
it with `jq`:

```bash
# Just the assembled prompts
jq 'select(.event.type == "prompt") | .event.pass' .prowl-review/debug.jsonl
# The post-judge findings + cost
jq 'select(.event.type == "judge" or .event.type == "cost") | .event' .prowl-review/debug.jsonl
```

## Development

```bash
npm install
npm run build   # tsup → dist/ (CLI + library)
npm run lint    # eslint
npm test        # vitest
```

The CLI entry point is `dist/cli.js` (bin: `prowl-review`):

```bash
node dist/cli.js --help
```

### Quality benchmark

Score the reviewer against the in-repo benchmark of PRs-with-known-bugs to
measure precision/recall/F1 and the clean-PR false-alarm rate (needs
`PROWL_AI_KEY`):

```bash
node dist/cli.js eval            # scores ./bench, prints a summary
```

See [`docs/eval.md`](docs/eval.md) for details and [`bench/README.md`](bench/README.md) for the case format.

## Examples & what a review looks like

Copy-paste starters live in [`examples/`](examples/) (auto-review workflow,
command workflow, and a `.prowl-review.yml`). For a rendered sample of the
published walkthrough — summary, findings table, 🤝 consensus, per-model
sections — see [`docs/example-review.md`](docs/example-review.md).

**Rolling out across a whole org?** Define the workflow once in your org's
`.github` repo and have every repo opt in with a few lines — see the reusable
`workflow_call` templates + per-repo callers in
[`examples/reusable/`](examples/reusable/) (#37).

## Contributing

Contributions are welcome! See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, the
project layout, conventions, and the Definition of Done, and
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). The roadmap is in
[`docs/backlog.md`](docs/backlog.md).

## Security & privacy

Found a vulnerability? Please report it privately — see [`SECURITY.md`](SECURITY.md)
(do not open a public issue). prowl-review is BYOK: your key is read from the
environment only, never stored or proxied, and your code only ever goes to **your**
chosen provider. **It collects no telemetry or analytics** — the only network
calls are to your LLM provider and the GitHub API.

## License

Apache-2.0 — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
