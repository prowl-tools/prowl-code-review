# Backlog

Prioritized list of planned features, improvements, and technical debt for **`prowl-review`** — a BYOK (bring-your-own-key) AI code-review tool for the Prowl QA suite. Delivered first as a GitHub Action + local CLI in TypeScript, reusing `prowl`'s toolchain and the provider abstraction from `prowl/src/generator/ai.ts`. Multi-provider (Claude default / OpenAI / Gemini). Apache-2.0.

User stories use: **As a `<role>`, I want `<capability>`, so that `<value>`.** Each carries acceptance criteria.

## High Priority

1. **TypeScript package scaffold matching `prowl`**
   As a maintainer, I want a new TS package (`prowl-review`) wired with prowl's exact toolchain, so that the reviewer is consistent with the rest of the suite and easy to ship.
   - Acceptance: `package.json` (name `prowl-review`, `bin`, scripts), `tsup.config.ts`, `tsconfig.json` (strict, ESM), `.eslintrc.cjs`, Vitest configured — copied/adapted from `prowl`.
   - Acceptance: `npm run build` produces a runnable `dist/cli.js`; `npx prowl-review --help` prints commands.
   - Acceptance: Apache-2.0 LICENSE + NOTICE present.

2. **Multi-provider BYOK LLM abstraction**
   As a developer, I want to pick Claude, OpenAI, or Gemini via env vars, so that I'm never locked to one vendor and bring my own key.
   - Acceptance: `providers/` exposes one interface; selection via `PROWL_AI_PROVIDER` (default `anthropic`) + `PROWL_AI_KEY`, mirroring `prowl/src/generator/ai.ts`.
   - Acceptance: Anthropic, OpenAI, and Gemini implementations with sane default models; raw `fetch` (no heavy SDKs), consistent with prowl.
   - Acceptance: unit tests cover provider selection and error on missing key; `fetch` mocked.

3. **Diff fetch + parsing with size guards**
   As a developer, I want the tool to fetch a PR's diff and parse it into files/hunks/lines, so that reviews target real changed code.
   - Acceptance: `github/diff.ts` fetches PR diff + metadata via Octokit (`@actions/github`).
   - Acceptance: `review/parse-diff.ts` maps hunks to file + new-side line numbers (needed later for inline comments).
   - Acceptance: config caps (`maxFiles`, `maxDiffBytes`) chunk or skip oversized diffs; skipped content is reported, not silently dropped.

4. **Findings schema + review prompt**
   As a developer, I want structured, severity-tagged findings from the LLM, so that output is consistent and machine-mappable.
   - Acceptance: Zod findings schema (`file`, `line`, `severity`, `title`, `body`, optional `suggestion`).
   - Acceptance: `review/prompt.ts` builds the code-review prompt from parsed diff + repo/PR context; provider returns validated findings.
   - Acceptance: unit tests validate schema parsing and reject malformed output.

5. **Summary review comment (MVP relief)**
   As a developer hitting CodeRabbit's caps, I want an automated summary review on every PR, so that I get uncapped reviews immediately.
   - Acceptance: posts one structured summary comment (findings grouped by file/severity) to the PR via REST.
   - Acceptance: idempotent — updates its prior summary comment instead of stacking duplicates on re-run.

6. **GitHub Action wrapper + dogfood**
   As a developer, I want a drop-in Action, so that adding one workflow file + an API-key secret enables reviews on any repo with no hosting.
   - Acceptance: `action.yml` (Node action) triggers on `pull_request` [opened, synchronize, ready_for_review, reopened]; runs `prowl-review review`.
   - Acceptance: uses auto `GITHUB_TOKEN` (pull-requests: write) + `PROWL_AI_KEY` secret.
   - Acceptance: dogfooded on this repo — a test PR with a deliberate bug produces a summary review.

7. **Inline review comments**
   As a reviewer, I want findings posted inline on the exact changed lines, so that the experience matches CodeRabbit.
   - Acceptance: `review/to-inline.ts` maps findings to `path`/`line`/`side`; submits a single review with `comments[]` + summary body via `POST .../pulls/{n}/reviews`.
   - Acceptance: findings outside the diff fall back into the summary rather than erroring.

## Medium Priority

8. **`@prowl-review` chat replies**
   As a developer, I want to mention the bot in a PR comment and get a contextual reply, so that I can ask follow-up questions in-thread.
   - Acceptance: `respond` command + Action triggers on `issue_comment` / `pull_request_review_comment` containing `@prowl-review`.
   - Acceptance: reply includes PR/diff context; threads correctly on review comments.

9. **Incremental re-review on new commits**
   As a developer, I want pushes to an open PR to review only the new changes, so that re-reviews are fast and cheap and don't repeat prior findings.
   - Acceptance: on `synchronize`, review only the delta since the last reviewed SHA; persist last-reviewed SHA (e.g., via a marker comment or check).

10. **`.prowl-review.yml` config + `init` command**
    As a developer, I want a per-repo config file, so that I can tune provider/model, path filters, severity threshold, tone, and ignore globs (CodeRabbit-style).
    - Acceptance: Zod-validated config loader (style of `prowl/src/config/schema.ts`); documented defaults.
    - Acceptance: `prowl-review init` scaffolds a commented config.

11. **Local pre-push CLI mode**
    As a developer, I want to run the same reviewer locally against a branch/diff before pushing, so that I get two layers of review with no extra tooling.
    - Acceptance: `prowl-review review --base <ref> --head <ref>` prints findings to the terminal without needing GitHub.

12. **Token-usage + cost logging**
    As a developer, I want per-review token/cost output, so that I can confirm I'm paying pennies and there's no per-hour cap.
    - Acceptance: logs input/output tokens and estimated cost per provider per run.

13. **Reusable org-level workflow**
    As an org owner, I want one reusable workflow referenced by all repos, so that "across all my projects" needs no YAML copy-paste.
    - Acceptance: documented `workflow_call` workflow (intended for `Prowl-qa/.github`) that any repo invokes in a few lines.

## Low Priority

14. **npm + Homebrew distribution**
    As a user, I want to install via npm or `brew`, so that adoption matches the rest of Prowl QA.
    - Acceptance: published `prowl-review` npm package; `Formula/prowl-review.rb` added to `homebrew-tap` (pulls npm tarball, Apache-2.0, node@20).

15. **Docs + marketing integration**
    As a prospective user, I want docs and a landing section, so that I can discover and set up the tool.
    - Acceptance: `docs/code-review.md` + sidebar entry in `prowl-docs`; a code-review section + install snippet in `prowl-web`; raccoon/brand conventions; "made for agents, controlled by humans" framing.

16. **Retire/replace baseline Anthropic workflows**
    As a maintainer, I want to remove the placeholder `claude-code-action` workflows once `prowl-review` reaches parity, so that the repo dogfoods its own tool.
    - Acceptance: replace `.github/workflows/claude-code-review.yml` after inline reviews (item 7) land; revisit `claude.yml` after `@prowl-review` chat (item 8) lands.

17. **Phase 2 — Hosted GitHub App (install-once)**
    As a user, I want an install-once app covering all repos/orgs automatically, so that I get CodeRabbit's managed UX without per-repo workflows.
    - Acceptance: design doc for a webhook service wrapping the same TS core (Vercel route or homelab) + GitHub App registration; optional Next.js dashboard reusing `prowl-hub` patterns. Build deferred until Action path is proven.

## Completed
