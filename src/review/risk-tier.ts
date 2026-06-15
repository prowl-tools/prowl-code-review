import type { DiffFile } from "./diff-types.js";

/**
 * Risk-tiered orchestration (backlog #31).
 *
 * A single-pass-count-for-every-PR review wastes money on tiny diffs (the cost
 * audit found each review fans out into agentic context retrieval + 4 specialist
 * passes + verification, and input tokens — diff + re-sent context across passes —
 * dominate the bill). This module scores a diff's size/complexity and picks a
 * tier that scales the two cost drivers: how many specialist passes run and how
 * much cross-file context is gathered. Cost then scales with risk.
 *
 * Pure and deterministic so it is fully unit-testable; the pipeline applies the
 * plan and reports the chosen tier (no silent coverage reduction, #5). Model
 * tiering is intentionally out of scope — the cheap-model-per-provider mapping is
 * a guess we avoid, and the user already controls the model.
 */

/** The three orchestration tiers, cheapest to most thorough. */
export type RiskTier = "minimal" | "standard" | "deep";

/** Size/complexity signals derived from the (already size-guarded) diff. */
export interface DiffComplexity {
  /** Added + deleted lines across every reviewed file. */
  changedLines: number;
  /** Number of reviewed files. */
  fileCount: number;
}

/** Thresholds that bound each tier; every field is overridable via config. */
export interface RiskTieringConfig {
  /** Master switch; when false every review runs the full `standard` set. Default true. */
  enabled?: boolean;
  /** Upper bounds for the cheap `minimal` tier (both must hold). */
  minimal?: { maxChangedLines?: number; maxFiles?: number };
  /** Lower bounds for the thorough `deep` tier (either triggers it). */
  deep?: { minChangedLines?: number; minFiles?: number };
}

/** Built-in tier thresholds (overridable via {@link RiskTieringConfig}). */
export const DEFAULT_TIER_THRESHOLDS = {
  minimal: { maxChangedLines: 30, maxFiles: 2 },
  deep: { minChangedLines: 500, minFiles: 20 }
} as const;

/** Built-in specialist lenses the `minimal` tier keeps (security is never dropped). */
export const MINIMAL_TIER_BUILTINS = ["correctness", "security"] as const;

/** Context-retrieval limits applied per tier (merged under any explicit config). */
export const TIER_CONTEXT_LIMITS: Record<RiskTier, { maxRounds: number; maxFiles: number } | undefined> = {
  minimal: { maxRounds: 3, maxFiles: 6 },
  standard: undefined, // leave the pipeline/config defaults untouched
  deep: { maxRounds: 8, maxFiles: 30 }
};

/** Outcome of tier selection: the tier plus the signals that chose it. */
export interface RiskTierSelection {
  tier: RiskTier;
  changedLines: number;
  fileCount: number;
}

/** Count added + deleted lines and files across the reviewed diff. */
export function diffComplexity(files: DiffFile[]): DiffComplexity {
  let changedLines = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.type === "add" || line.type === "del") {
          changedLines += 1;
        }
      }
    }
  }
  return { changedLines, fileCount: files.length };
}

/**
 * Pick the orchestration tier for a diff. Disabled config (or an explicit
 * `enabled: false`) always yields `standard`. `deep` wins when either deep bound
 * is met; `minimal` requires both minimal bounds; everything else is `standard`.
 */
export function selectRiskTier(
  complexity: DiffComplexity,
  config: RiskTieringConfig = {}
): RiskTierSelection {
  const { changedLines, fileCount } = complexity;
  const base: RiskTierSelection = { tier: "standard", changedLines, fileCount };
  if (config.enabled === false) {
    return base;
  }

  const minimalMaxLines = config.minimal?.maxChangedLines ?? DEFAULT_TIER_THRESHOLDS.minimal.maxChangedLines;
  const minimalMaxFiles = config.minimal?.maxFiles ?? DEFAULT_TIER_THRESHOLDS.minimal.maxFiles;
  const deepMinLines = config.deep?.minChangedLines ?? DEFAULT_TIER_THRESHOLDS.deep.minChangedLines;
  const deepMinFiles = config.deep?.minFiles ?? DEFAULT_TIER_THRESHOLDS.deep.minFiles;

  // Deep takes precedence: a large/complex diff is worth the full treatment even
  // if (say) it touches few files but changes a lot of lines.
  if (changedLines >= deepMinLines || fileCount >= deepMinFiles) {
    return { ...base, tier: "deep" };
  }
  if (changedLines <= minimalMaxLines && fileCount <= minimalMaxFiles) {
    return { ...base, tier: "minimal" };
  }
  return base;
}

/** The orchestration adjustments a tier applies. */
export interface TierPlan {
  /**
   * When set, restrict the built-in specialist lenses to these keys (custom
   * reviewers are the user's explicit intent and always run). Undefined = run
   * the full configured set.
   */
  builtinSpecialistKeys?: string[];
  /** Context-retrieval limits to apply where the user hasn't set their own. */
  contextLimits?: { maxRounds?: number; maxFiles?: number };
}

/** Translate a tier into the concrete orchestration adjustments to apply. */
export function planOrchestration(tier: RiskTier): TierPlan {
  switch (tier) {
    case "minimal":
      return {
        builtinSpecialistKeys: [...MINIMAL_TIER_BUILTINS],
        contextLimits: TIER_CONTEXT_LIMITS.minimal
      };
    case "deep":
      return { contextLimits: TIER_CONTEXT_LIMITS.deep };
    case "standard":
    default:
      return {};
  }
}
