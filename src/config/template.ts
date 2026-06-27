/**
 * The commented `.prowl-review.yml` scaffold written by `prowl-review init`
 * (backlog #29). All options are commented out, so a fresh file documents the
 * knobs without changing any behavior until the user opts in by uncommenting.
 */
export const CONFIG_TEMPLATE = `# .prowl-review.yml — configuration for prowl-review (BYOK AI code review)
# All options are optional. Commented values document defaults or safe examples.
# Uncomment and edit only what you want to change.
# Precedence: CLI flag > this file > built-in default.
#
# Secrets never go here. Provider API keys always come from PROWL_AI_KEY or
# PROWL_AI_KEY_<PROVIDER> environment variables, never this file.

# --- Provider -----------------------------------------------------------------
# Which LLM to use. The API key still comes from the environment.
# Non-empty PROWL_AI_PROVIDER / PROWL_AI_MODEL env vars override these when set.
# In GitHub Actions, use a trusted config-path input if you want Action config;
# the Action ignores repo config by default for untrusted PR checkouts.
# Set provider whenever you set model, because model names are provider-specific.
# provider: anthropic        # anthropic | openai | gemini
# model: <provider default>  # e.g. claude-... / gpt-... / gemini-...

# --- Presentation -------------------------------------------------------------
# agentPrompt: true          # append a copy-paste "Resolve with an AI agent" prompt to each finding

# --- Budget cap ---------------------------------------------------------------
# Per-PR spend ceiling. When hit, agentic context retrieval stops and the
# verification pass is skipped (specialist passes still run); the over-budget
# total is reported. Set maxTokens and/or maxUsd (the tighter wins). maxUsd is
# converted to a token ceiling via the model's input rate (estimated).
# budget:
#   maxUsd: 0.50
#   maxTokens: 200000

# --- Cost estimate pricing ----------------------------------------------------
# Per-review cost is estimated and emitted to the run logs + the GitHub Action
# job summary (never the PR comment); "prowl-review costs" aggregates local runs.
# Override the built-in price table (USD per 1M tokens) when a rate is stale or a
# model isn't listed. Your provider dashboard is the source of truth.
# pricing:
#   claude-sonnet-4-6: { input: 3, output: 15, cachedInput: 0.3 }

# --- Ignore list --------------------------------------------------------------
# Generated/vendored files skipped before review (reported as "ignored", not
# dropped silently). Built-in defaults cover lockfiles, node_modules, vendor,
# dist/build/out, coverage, .next/.turbo, and test snapshots. Setting this
# REPLACES the defaults; use [] to ignore nothing.
# ignore:
#   - node_modules
#   - "*.snap"
#   - "src/generated/**"

# --- Multi-provider ensemble --------------------------------------------------
# Review the same changes with more than one provider at once and pool the
# findings (#53). Opt-in, default off. Each provider's key comes from its own env
# var: PROWL_AI_KEY_ANTHROPIC / PROWL_AI_KEY_OPENAI / PROWL_AI_KEY_GEMINI (the
# provider matching your primary also falls back to PROWL_AI_KEY; scoped keys
# win when both are set). A provider with no key is skipped; with fewer than two
# keys it runs as a normal review.
# Findings agreed on by multiple providers get a confidence boost + a 🤝 badge.
# Cost is ~N× a single-provider review (the per-PR budget above is split across
# providers); cross-file context + linters run once and are shared.
# ensemble:
#   enabled: true
#   providers:
#     - provider: anthropic
#     - provider: openai
#       # model: gpt-5.2

# --- Issue / ticket validation ------------------------------------------------
# When a PR links a GitHub issue (a closing keyword like "Closes #12", an
# owner/repo#n reference, or an issue URL in the title/body), pull the issue's
# acceptance criteria and flag any the diff doesn't satisfy (#32). Opt-in.
# issueValidation:
#   enabled: true
#   maxIssues: 3        # cap linked issues fetched per PR (default 3)

# --- Auto-generated PR description --------------------------------------------
# When a PR is opened with an empty description, write one from the diff (#33),
# CodeRabbit-style. Opt-in. The generated text lives between markers in the PR
# body and refreshes on new commits; a human-authored description is never
# overwritten. Needs pull-requests: write (already required to post reviews).
# prDescription:
#   enabled: true

# --- LLM resilience -----------------------------------------------------------
# Retry/backoff on transient provider errors is always on. Failback is opt-in:
# on sustained overload (retryable errors that survive retries), retry with an
# older model of the SAME family before giving up (#17) — a degraded-but-real
# review beats a failed pass. Never crosses providers.
# resilience:
#   failback:
#     enabled: true

# --- Debug / verbose tracing --------------------------------------------------
# Write a structured JSONL run trace (assembled prompts, fetched-context list,
# findings at each stage, token/cost breakdown) for diagnosing odd reviews (#49).
# Secrets are redacted; one line per event. The --debug flag and PROWL_DEBUG /
# PROWL_DEBUG_LOG env take precedence. Off by default. The path is confined to
# the workspace, rejects symlinked path components, and nested parent directories
# are created automatically.
# debug:
#   enabled: true
#   path: .prowl-review/debug.jsonl

# --- Review tuning ------------------------------------------------------------
# review:
#   minSeverity: minor       # report at/above: critical | major | minor | trivial | info
#   minConfidence: 0.5       # drop non-critical findings below this confidence (0–1)
#   maxFindings: 25          # cap the number of findings surfaced
#   maxInlineComments: 20    # cap inline comments; overflow rolls into the summary (0 = none inline)
#   verify: true             # run the skeptical false-positive verification pass
#   verifyConfidence: 0.8    # non-blocking findings at/above this confidence skip verification (0–1)
#   incremental: true        # on a re-push, review only the delta since the last reviewed commit (#23)
#   resolveThreads: true     # on a re-push, resolve no-longer-current/settled finding threads and honor replies (#22)
#                            # (reply to a finding "won't fix" / "acknowledged" to resolve it; "disagree" keeps it open)
#   rejustifyDisputed: true  # on "disagree", the judge defends the finding in-thread or withdraws it (#22)
#   auto: true               # auto-review PR events; set false for on-demand only (@prowl-review review) (#28)
#   reviewDrafts: false      # also auto-review draft PRs; default skips drafts until "ready for review" (#28)

# --- Suggested-fix validation -------------------------------------------------
# Committable one-click suggestion blocks are only offered for findings at or
# above this confidence (and that pass a structural sanity check) (#39).
# Lower-confidence fixes still appear in each finding's agent prompt.
# suggestions:
#   minConfidence: 0.8

# --- Specialist reviewers -----------------------------------------------------
# The multi-pass review runs built-in lenses (correctness, security, performance,
# tests). Toggle any of them off, and/or add your own reviewers — each runs as an
# extra pass and feeds the same judge/dedup. Each custom reviewer is a full LLM
# pass, so the count drives cost (max 10).
# specialists:
#   builtins:
#     performance: false     # turn a built-in lens off (absent keys stay on)
#   custom:
#     - key: compliance      # lowercase/alphanumeric/hyphen; also the finding category; "lint" and "requirements" are reserved
#       title: Compliance    # optional; derived from key when omitted
#       focus: "Flag changes that violate our internal RFC-1234 logging standard."
#       avoid: "General style nits unrelated to the standard."   # optional
#       severityFloor: major # optional; drop this reviewer's findings below it

# --- Risk-tiered orchestration ------------------------------------------------
# Scale cost with risk: tiny diffs run a reduced pass set + less context
# ("minimal"), large/complex ones get the full treatment with more context
# ("deep"); everything else is "standard". The chosen tier is logged with the
# cost line, and a minimal-tier run is noted in the review. Defaults shown.
# riskTiering:
#   enabled: true            # set false to always run the full "standard" review
#   minimal:                 # both bounds must hold for the cheap tier
#     maxChangedLines: 30
#     maxFiles: 2
#   deep:                    # either bound triggers the thorough tier
#     minChangedLines: 500
#     minFiles: 20

# --- Merge gate (GitHub Check Run) --------------------------------------------
# Publish a Check Run summarizing the review with per-line annotations. Opt-in;
# needs the workflow to grant "checks: write". With failOn set, findings at or
# above that severity fail the check (and can block merge once the org marks the
# "prowl-review" check Required in branch protection); omit failOn for an
# informational check that never fails.
# checkRun:
#   enabled: false
#   failOn: critical         # critical | major | minor | trivial | info

# --- Approval rubric + break-glass --------------------------------------------
# Map findings to a GitHub review event so the gate is predictable: findings at
# or above requestChangesAt make the bot REQUEST CHANGES; an otherwise clean
# review comments (or approves, if approveWhenClean or clearing its own prior
# request-changes review). Opt-in; off by default the
# bot only ever comments. A repo owner/member/collaborator can override a
# request-changes by commenting "@prowl-review break glass <head-sha>" — that
# force-approves past the blocking finding only for that exact head SHA, and is recorded
# in the review for auditability. Approval is withheld if review coverage is
# incomplete or files were skipped. When the Check Run (above) is also enabled,
# it follows this same decision and fails on incomplete coverage.
# approval:
#   enabled: false
#   requestChangesAt: critical  # critical | major | minor | trivial | info
#   approveWhenClean: false     # approve (not just comment) when nothing is at/above the threshold
#   breakGlass: true            # honor "@prowl-review break glass <head-sha>" overrides

# --- Cross-file context (agentic retrieval) -----------------------------------
# context:
#   enabled: true            # gather callers/definitions/related files before reviewing
#   maxRounds: 6             # max tool-use rounds
#   maxFiles: 20             # max distinct files the agent may read

# --- Linter / SAST grounding --------------------------------------------------
# Built-in runners: ESLint (JS/TS, trusted workspace only), Ruff (Python),
# Gitleaks (secrets), Semgrep (SAST), and osv-scanner (dependencies, below).
# grounding:
#   enabled: true            # run repo linters and feed results into the review
#   semgrep:                 # SAST runner (#16b); on by default, skips if not installed
#     enabled: true
#     config: p/default      # ruleset: registry pack only (p/.../r/.../auto);
#                            # repo paths and remote URLs are skipped. Metrics
#                            # are always disabled.
#
# Workspace execution trust is intentionally not read from repo config.
# Use --trust-workspace, PROWL_TRUST_WORKSPACE, or the trust-workspace Action
# input only for trusted checkouts.

# --- Dependency-CVE / license scanning ----------------------------------------
# When a dependency lockfile changes, scan it with osv-scanner for known CVEs
# (#34). Reads lockfiles only (no repo code), runs by default, and skips
# gracefully when osv-scanner isn't installed. Set an SPDX allowlist to also flag
# dependencies whose license falls outside it.
# dependencyScan:
#   enabled: true
#   licenses:
#     allow: [MIT, Apache-2.0, BSD-3-Clause, ISC]

# --- Diff size guards ---------------------------------------------------------
# diff:
#   # Leave maxFiles / maxBytes unset for no cap.
#   # Set either value to a positive integer to enable a cap, for example:
#   # maxFiles: 100
#   # maxBytes: 200000
`;
