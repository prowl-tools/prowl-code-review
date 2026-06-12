import { z } from "zod";
import { SEVERITIES } from "../review/findings.js";
import { PROVIDER_NAMES } from "../providers/index.js";

/**
 * `.prowl-review.yml` schema (backlog #29).
 *
 * The config tunes the review without code changes. It is entirely optional —
 * a repo with no config file reviews with the documented defaults, so the
 * GitHub Action works out of the box. Precedence is **CLI flag > config file >
 * built-in default** (and, for the provider, the BYOK env vars still win — see
 * the review command).
 *
 * Secrets never live here: the provider API key always comes from `PROWL_AI_KEY`
 * in the environment, never the repo. Only the non-secret provider/model
 * *selection* is configurable.
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
    enabled: z.boolean().optional(),
    /**
     * Allow grounding to execute repository-defined linter code/config in the
     * checkout. Default false — untrusted PR checkouts must not run their own
     * lint config. Leave off in CI on untrusted forks.
     */
    trustWorkspace: z.boolean().optional()
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

/** Full `.prowl-review.yml` schema. */
export const configSchema = z
  .object({
    /** Provider selection (the API key always comes from `PROWL_AI_KEY`). */
    provider: z.enum(PROVIDER_NAMES as [string, ...string[]]).optional(),
    /** Model override; the provider's default model is used when omitted. */
    model: z.string().min(1).optional(),
    review: reviewSchema.optional(),
    context: contextSchema.optional(),
    grounding: groundingSchema.optional(),
    diff: diffSchema.optional()
  })
  .strict();

/** A parsed (not-yet-defaulted) config, exactly as it appears in the file. */
export type ProwlReviewConfig = z.infer<typeof configSchema>;
