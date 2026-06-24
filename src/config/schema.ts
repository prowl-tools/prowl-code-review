import { z } from "zod";
import { SEVERITIES } from "../review/findings.js";
import { BUILTIN_SPECIALIST_KEYS } from "../review/specialists.js";
import { PROVIDER_NAMES } from "../providers/index.js";

/**
 * `.prowl-review.yml` schema (backlog #29).
 *
 * The config tunes the review without code changes. It is entirely optional —
 * a repo with no config file reviews with the documented defaults, so the
 * GitHub Action works out of the box. Precedence is **CLI flag > config file >
 * built-in default** (and, for the provider, the BYOK env vars still win — see
 * the review command). Workspace execution trust is intentionally not accepted
 * from repo config; use the CLI/env/action input for trusted checkouts.
 *
 * Secrets never live here: provider API keys always come from `PROWL_AI_KEY` or
 * `PROWL_AI_KEY_<PROVIDER>` in the environment, never the repo. Only the
 * non-secret provider/model *selection* is configurable. A config `model` must
 * be paired with `provider` so provider-specific model names are never guessed.
 *
 * The schema is `.strict()` at every level so a typo (e.g. `minSeverty`) is a
 * loud validation error rather than a silently-ignored key.
 */

const severityEnum = z.enum(SEVERITIES);

/** Review-pass tuning: the judge floors (#55) and the verification pass (#8). */
const reviewSchema = z
  .object({
    /** Drop findings below this severity. Default `minor`. */
    minSeverity: severityEnum.optional(),
    /** Drop non-critical findings below this confidence (0–1). Default 0.5. */
    minConfidence: z.number().min(0).max(1).optional(),
    /** Cap the number of findings surfaced. Default 25. */
    maxFindings: z.number().int().positive().optional(),
    /** Cap inline comments per review; overflow rolls into the summary. Default 20 (#25). */
    maxInlineComments: z.number().int().nonnegative().optional(),
    /** Run the skeptical false-positive verification pass. Default true. */
    verify: z.boolean().optional(),
    /** Findings at/above this confidence skip verification (0–1). Default 0.8. */
    verifyConfidence: z.number().min(0).max(1).optional(),
    /** On a re-run, review only the delta since the last reviewed SHA. Default true (#23). */
    incremental: z.boolean().optional(),
    /** On a re-run, resolve fixed/settled threads and honor human replies. Default true (#22). */
    resolveThreads: z.boolean().optional(),
    /**
     * Auto-review pull-request events. Default true. Set false for on-demand
     * only: the bot reviews only when asked with `@prowl-review review` (#28).
     */
    auto: z.boolean().optional(),
    /**
     * Auto-review draft pull requests too. Default false — drafts are skipped
     * until marked "ready for review" (or an explicit `@prowl-review review`) (#28).
     */
    reviewDrafts: z.boolean().optional()
  })
  .strict();

/** Agentic cross-file context retrieval bounds (#4). */
const contextSchema = z
  .object({
    /** Gather cross-file context before reviewing. Default true. */
    enabled: z.boolean().optional(),
    /** Max tool-use rounds. Default 6. */
    maxRounds: z.number().int().positive().optional(),
    /** Max distinct files the agent may read. Default 20. */
    maxFiles: z.number().int().positive().optional()
  })
  .strict();

/** Linter/SAST grounding controls (#16). */
const groundingSchema = z
  .object({
    /** Run repo linters and feed results into the review. Default true. */
    enabled: z.boolean().optional()
  })
  .strict();

/** Diff size guards: cap what is sent to the provider (no silent truncation). */
const diffSchema = z
  .object({
    /** Max changed files reviewed; the rest are reported as skipped. */
    maxFiles: z.number().int().positive().optional(),
    /** Max total diff bytes sent to the provider. */
    maxBytes: z.number().int().positive().optional()
  })
  .strict();

/** Per-PR spend ceiling (#18); set either or both — the tighter wins. */
const budgetSchema = z
  .object({
    /** Max total tokens across the review. */
    maxTokens: z.number().int().positive().optional(),
    /** Max estimated USD (converted to a token ceiling via the model's input rate). */
    maxUsd: z.number().positive().optional()
  })
  .strict();

/** Toggle the built-in review lenses on/off by key; absent keys stay enabled (#51). */
const builtinSpecialistsSchema = z
  .object(
    Object.fromEntries(BUILTIN_SPECIALIST_KEYS.map((key) => [key, z.boolean().optional()]))
  )
  .strict();

/** One custom reviewer added to the multi-pass set (#51). */
const customSpecialistSchema = z
  .object({
    /** Category key (lowercase/alphanumeric/hyphen); also the finding category. */
    key: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/, "key must be lowercase alphanumeric or hyphens (e.g. compliance)"),
    /** Optional human title; derived from the key when omitted. */
    title: z.string().min(1).max(80).regex(/^[^\r\n]+$/, "title must be a single line").optional(),
    /** What this reviewer should look for (the focus prompt). */
    focus: z.string().min(1).max(4000),
    /** Optional "what NOT to flag"; a generic noise guard is used when omitted. */
    avoid: z.string().min(1).max(4000).optional(),
    /** Optional severity floor — drop this reviewer's findings below it. */
    severityFloor: severityEnum.optional()
  })
  .strict();

/**
 * Custom / configurable specialist reviewers (#51). Built-ins can be toggled off,
 * and custom reviewers run as extra passes that feed the same judge/dedup. Capped
 * at 10 custom reviewers — each is a full LLM pass, so the count drives cost.
 */
const specialistsSchema = z
  .object({
    builtins: builtinSpecialistsSchema.optional(),
    custom: z.array(customSpecialistSchema).max(10).optional()
  })
  .strict();

/** Categories reserved for deterministic + built-in conditional findings. */
const RESERVED_CUSTOM_SPECIALIST_KEYS = new Set(["lint", "requirements"]);

/** Risk-tiered orchestration thresholds (#31); all bounds are optional overrides. */
const riskTieringSchema = z
  .object({
    /** Master switch; false → every review runs the full `standard` set. Default true. */
    enabled: z.boolean().optional(),
    /** Upper bounds for the cheap `minimal` tier (both must hold). */
    minimal: z
      .object({
        maxChangedLines: z.number().int().positive().optional(),
        maxFiles: z.number().int().positive().optional()
      })
      .strict()
      .optional(),
    /** Lower bounds for the thorough `deep` tier (either triggers it). */
    deep: z
      .object({
        minChangedLines: z.number().int().positive().optional(),
        minFiles: z.number().int().positive().optional()
      })
      .strict()
      .optional()
  })
  .strict();

/** Merge gate via the Checks API (#24). Opt-in; needs `checks: write`. */
const checkRunSchema = z
  .object({
    /** Publish a Check Run summarizing the review. Default false (opt-in). */
    enabled: z.boolean().optional(),
    /**
     * Severity at/above which the check fails (and can block merge via branch
     * protection). Omit for an informational (neutral) check that never fails.
     */
    failOn: severityEnum.optional()
  })
  .strict();

/** Approval rubric + break-glass override (#52). Opt-in. */
const approvalSchema = z
  .object({
    /** Engage the rubric (map findings → a review event). Default false (comment only). */
    enabled: z.boolean().optional(),
    /** Severity at/above which the review requests changes. Default `critical`. */
    requestChangesAt: severityEnum.optional(),
    /** Approve (not just comment) when nothing is at/above the threshold. Default false. */
    approveWhenClean: z.boolean().optional(),
    /** Honor `@prowl-review break glass <head-sha>` overrides from trusted authors. Default true. */
    breakGlass: z.boolean().optional()
  })
  .strict();

/** USD-per-1M-token price override for one model (#36). */
const modelPriceSchema = z
  .object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cachedInput: z.number().nonnegative().optional()
  })
  .strict();

/** Full `.prowl-review.yml` schema. */
/** One provider in the ensemble (#53); its key comes from the env, never config. */
const ensembleProviderSchema = z
  .object({
    /** Provider to run in the ensemble. */
    provider: z.enum(PROVIDER_NAMES as [string, ...string[]]),
    /** Model override for this provider; the provider's default is used when omitted. */
    model: z.string().min(1).optional()
  })
  .strict();

/**
 * Multi-provider ensemble review (#53). Opt-in, default off. Each provider's key
 * is read from `PROWL_AI_KEY_<PROVIDER>` (the primary also falls back to
 * `PROWL_AI_KEY`; scoped keys win when both are set); a provider with no key is
 * skipped with a note. With fewer than two usable providers the review runs as a
 * normal single-provider review.
 */
const ensembleSchema = z
  .object({
    /** Run the same changes through multiple providers and pool findings. Default false. */
    enabled: z.boolean().optional(),
    /** Providers to run; order is cosmetic. At least one entry when enabled. */
    providers: z.array(ensembleProviderSchema).optional()
  })
  .strict();

/**
 * Auto-generated PR descriptions (#33). Opt-in, default off. When enabled,
 * prowl-review writes a description from the diff for a PR opened with an empty
 * body (and refreshes its own generated block on later pushes); it never
 * overwrites a human-authored description.
 */
const prDescriptionSchema = z
  .object({
    enabled: z.boolean().optional()
  })
  .strict();

/**
 * Issue/ticket validation (#32). Opt-in, default off. When enabled and the PR
 * links a GitHub issue (a closing keyword or issue URL in the title/body), the
 * review pulls the issue's acceptance criteria and a requirements lens flags any
 * the diff doesn't satisfy.
 */
const issueValidationSchema = z
  .object({
    enabled: z.boolean().optional(),
    /** Max linked issues fetched per PR (bounds cost). Default 3. */
    maxIssues: z.number().int().positive().optional()
  })
  .strict();

export const configSchema = z
  .object({
    /** Provider selection (API keys always come from environment variables). */
    provider: z.enum(PROVIDER_NAMES as [string, ...string[]]).optional(),
    /** Model override for the configured provider; the provider's default model is used when omitted. */
    model: z.string().min(1).optional(),
    /** Append a copy-paste "Resolve with an AI agent" prompt to each finding. Default true (#57). */
    agentPrompt: z.boolean().optional(),
    /**
     * Glob patterns for generated/vendored files to skip (#19). Replaces the
     * built-in defaults when set; `[]` ignores nothing. Omit to use the defaults.
     */
    ignore: z.array(z.string().min(1)).optional(),
    /**
     * Per-model cost override (#36), keyed by model id, USD per 1M tokens. Merged
     * over the built-in estimate table; cost figures are always estimates.
     */
    pricing: z.record(z.string().min(1), modelPriceSchema).optional(),
    /** Per-PR spend ceiling (#18): caps context retrieval + skips verification when spent. */
    budget: budgetSchema.optional(),
    /** Toggle built-in lenses + add custom reviewers to the multi-pass set (#51). */
    specialists: specialistsSchema.optional(),
    /** Scale pass count + context to diff size/complexity (#31). */
    riskTiering: riskTieringSchema.optional(),
    /** Merge gate via the Checks API (#24); opt-in. */
    checkRun: checkRunSchema.optional(),
    /** Approval rubric + break-glass override (#52); opt-in. */
    approval: approvalSchema.optional(),
    /** Multi-provider ensemble review (#53); opt-in, default off. */
    ensemble: ensembleSchema.optional(),
    /** Auto-generate a PR description from the diff when the body is empty (#33); opt-in. */
    prDescription: prDescriptionSchema.optional(),
    /** Validate the PR against its linked issue's acceptance criteria (#32); opt-in. */
    issueValidation: issueValidationSchema.optional(),
    review: reviewSchema.optional(),
    context: contextSchema.optional(),
    grounding: groundingSchema.optional(),
    diff: diffSchema.optional()
  })
  .strict()
  .superRefine((config, ctx) => {
    if (config.model && !config.provider) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["model"],
        message: "model requires provider so model names stay provider-scoped"
      });
    }

    const custom = config.specialists?.custom ?? [];
    const builtinKeys = new Set<string>(BUILTIN_SPECIALIST_KEYS);
    const seen = new Set<string>();
    custom.forEach((reviewer, index) => {
      if (builtinKeys.has(reviewer.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["specialists", "custom", index, "key"],
          message: `custom specialist key "${reviewer.key}" collides with a built-in; pick another`
        });
      }
      if (RESERVED_CUSTOM_SPECIALIST_KEYS.has(reviewer.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["specialists", "custom", index, "key"],
          message: `custom specialist key "${reviewer.key}" is reserved for deterministic findings; pick another`
        });
      }
      if (seen.has(reviewer.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["specialists", "custom", index, "key"],
          message: `duplicate custom specialist key "${reviewer.key}"`
        });
      }
      seen.add(reviewer.key);
    });

    // Don't let a config disable every lens and leave the review with nothing to run.
    const builtins = config.specialists?.builtins;
    const allBuiltinsOff =
      builtins !== undefined && BUILTIN_SPECIALIST_KEYS.every((key) => builtins[key] === false);
    if (allBuiltinsOff && custom.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["specialists"],
        message: "at least one specialist must remain enabled (all built-ins are off and no custom reviewers are defined)"
      });
    }
  });

/** A parsed (not-yet-defaulted) config, exactly as it appears in the file. */
export type ProwlReviewConfig = z.infer<typeof configSchema>;
