# Bot commands

Drive prowl-review from pull-request comments with `@prowl-review <command>`. Only
mentions from a repo **owner / member / collaborator** are honored — the tool
re-checks author trust itself, independently of any workflow guard.

| Command | Effect |
|---|---|
| `@prowl-review review` | Re-review the latest changes (incremental). |
| `@prowl-review full review` | Re-scan the entire PR from scratch. |
| `@prowl-review ignore` | Reply on a finding to mute it — it won't be raised again on this PR (and repo-wide when [`review.repoLearnings`](repo-wide-learnings.md) is on). |
| `@prowl-review resolve` | Reply on a finding to mark its thread resolved and stop re-raising it (closes the thread, unlike `ignore`). |
| `@prowl-review configure <key=value …>` | Set per-PR overrides for `minSeverity`, `maxFindings`, and `verify`; `configure reset` clears them. |
| `@prowl-review pause` / `resume` | Stop / re-enable auto-review on new pushes for this PR. |
| `@prowl-review break glass <head-sha>` | Re-run the approval gate past a blocking finding, for that exact head SHA — only when `approval.breakGlass` is on. |
| `@prowl-review docstrings` | Draft docstrings for the changed code, posted as a copy-paste reply. |
| `@prowl-review tests` | Draft unit-test stubs for the changed code. |
| `@prowl-review help` | List the available commands. |
| `@prowl-review <question>` | Ask a free-form question — answered in-thread, grounded in the PR diff. |

Anything after the mention that isn't a known verb is treated as a question:
`@prowl-review why is this loop O(n²)?` gets a contextual reply in the same
thread. `docstring`/`doc`/`docs` and `test` are accepted as aliases.

## Code assists

`docstrings` drafts docstrings/doc-comments for the functions, classes, and
methods changed in the PR, in each file's language convention. `tests` drafts
unit-test stubs covering the changed behavior, inferring the project's test
framework from the diff. Both are grounded in the size-guarded, secret-redacted
PR diff and reply with copy-paste-ready fenced code blocks — in-thread when
invoked on an inline comment, otherwise as a PR comment. They are suggestions to
review before committing, never auto-applied.

## Replying to findings

Reply on a finding's thread and prowl-review honors it on the next review:
"won't fix" / "acknowledged" resolves the thread and stops re-raising it. Reply
**"I disagree"** (or "false positive", "not a bug") and the judge actively
**re-evaluates** — it either defends the finding with reasoning (thread stays
open, still gates merge) or withdraws it (concedes and resolves). Only an
owner/member/collaborator reply is honored. Turn this off with
`review.rejustifyDisputed: false`, and a disputed finding is simply withheld
instead.

## Per-PR settings

`@prowl-review configure minSeverity=major maxFindings=10 verify=off` sets review
settings for the current PR only; they persist in the summary's state marker and
win over the repo config. The allowlist is deliberately small — **`minSeverity`,
`maxFindings`, `verify`** — and every value is validated, so a typo replies with
usage instead of silently weakening the review. Use `@prowl-review configure
reset` to clear them.

## Wiring the command workflow

The command mode is the same Action with `mode: command`. Wire `issue_comment`
for PR conversation comments, and add `pull_request_review_comment` if you want
inline finding-thread replies (`ignore`, `resolve`, in-thread questions) to work
— note each inline comment creates a workflow run, so leave it out if you don't
need it. See [GitHub Action](github-action.md#commands) for the full workflow.
