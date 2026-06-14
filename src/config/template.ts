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
# Secrets never go here. The provider API key always comes from the
# PROWL_AI_KEY environment variable, never this file.

# --- Provider -----------------------------------------------------------------
# Which LLM to use. The API key still comes from PROWL_AI_KEY; the matching
# Non-empty PROWL_AI_PROVIDER / PROWL_AI_MODEL env vars override these when set.
# In GitHub Actions, use a trusted config-path input if you want Action config;
# the Action ignores repo config by default for untrusted PR checkouts.
# Set provider whenever you set model, because model names are provider-specific.
# provider: anthropic        # anthropic | openai | gemini
# model: <provider default>  # e.g. claude-... / gpt-... / gemini-...

# --- Presentation -------------------------------------------------------------
# agentPrompt: true          # append a copy-paste "Resolve with an AI agent" prompt to each finding

# --- Review tuning ------------------------------------------------------------
# review:
#   minSeverity: minor       # report at/above: critical | major | minor | trivial | info
#   minConfidence: 0.5       # drop non-critical findings below this confidence (0–1)
#   maxFindings: 25          # cap the number of findings surfaced
#   verify: true             # run the skeptical false-positive verification pass
#   verifyConfidence: 0.8    # non-blocking findings at/above this confidence skip verification (0–1)

# --- Cross-file context (agentic retrieval) -----------------------------------
# context:
#   enabled: true            # gather callers/definitions/related files before reviewing
#   maxRounds: 6             # max tool-use rounds
#   maxFiles: 20             # max distinct files the agent may read

# --- Linter / SAST grounding --------------------------------------------------
# grounding:
#   enabled: true            # run repo linters and feed results into the review
#
# Workspace execution trust is intentionally not read from repo config.
# Use --trust-workspace, PROWL_TRUST_WORKSPACE, or the trust-workspace Action
# input only for trusted checkouts.

# --- Diff size guards ---------------------------------------------------------
# diff:
#   # Leave maxFiles / maxBytes unset for no cap.
#   # Set either value to a positive integer to enable a cap, for example:
#   # maxFiles: 100
#   # maxBytes: 200000
`;
