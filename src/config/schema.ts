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
 * Secrets never live here: the provider API key always comes from `PROWL_AI_KEY`
 * in the environment, never the repo. Only the non-secret provider/model
 * *selection* is configurable. A config `model` must be paired with `provider`
 * so provider-specific model names are never guessed.
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
    verifyConfidence: z.number().min(0).max(1).optional()
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

/** USD-per-1M-token price override for one model (#36). */
const modelPriceSchema = z
  .object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cachedInput: z.number().nonnegative().optional()
  })
  .strict();

/** Full `.prowl-review.yml` schema. */
export const configSchema = z
  .object({
    /** Provider selection (the API key always comes from `PROWL_AI_KEY`). */
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
