import { z } from "zod";
import { SEVERITIES, type Severity } from "../review/findings.js";
import type { RiskTier } from "../review/risk-tier.js";

/**
 * Quality eval harness types (backlog #13).
 *
 * A benchmark is a set of cases. Each case is a self-contained unified diff
 * labelled either `bug` (it contains known, located defects) or `clean` (it
 * should produce no findings). The runner feeds each diff through the real
 * review pipeline (#6/#8) and scores the findings against the case's expected
 * bugs — so we can *prove* precision/recall instead of guessing, and catch
 * regressions before release.
 *
 * Cases are stored in-repo (not fetched from GitHub) so a run is reproducible
 * and needs no network or tokens beyond the LLM call itself.
 */

/** A single known defect seeded in a benchmark case, located for matching. */
export const ExpectedBugSchema = z
  .object({
    /** Repo-relative file the defect lives on (new side of the diff). */
    file: z.string().min(1),
    /** 1-based new-side line where the defect starts. */
    line: z.number().int().positive(),
    /** End line for a multi-line defect (defaults to `line`). */
    endLine: z.number().int().positive().optional(),
    /** Optional expected category (e.g. correctness/security); matched only when `requireCategory`. */
    category: z.string().min(1).optional(),
    /** Optional expected severity, for reporting (not used in matching). */
    severity: z.enum(SEVERITIES).optional(),
    /** Human note describing the seeded bug. */
    note: z.string().min(1)
  })
  .refine((bug) => bug.endLine === undefined || bug.endLine >= bug.line, {
    message: "endLine must be greater than or equal to line",
    path: ["endLine"]
  });

export type ExpectedBug = z.infer<typeof ExpectedBugSchema>;

/** What a benchmark case asserts about the reviewer's output. */
export const CASE_KINDS = ["bug", "clean"] as const;
export type CaseKind = (typeof CASE_KINDS)[number];

/** One self-contained benchmark case. */
export const BenchmarkCaseSchema = z
  .object({
    /** Stable identifier (also the fixture file stem). */
    id: z.string().min(1),
    /** Plain-language description of what the case exercises. */
    description: z.string().min(1),
    /** `bug` = contains the listed defects; `clean` = should yield no findings. */
    kind: z.enum(CASE_KINDS),
    /** The unified diff under review (the new-side line numbers anchor `expected`). */
    diff: z.string().min(1),
    /** Optional cross-file context to supply (as the agentic retriever would). */
    context: z.string().optional(),
    /** Optional project review guidelines for the case. */
    guidelines: z.string().optional(),
    /** Known defects (required & non-empty for `bug`; must be empty for `clean`). */
    expected: z.array(ExpectedBugSchema).default([])
  })
  .superRefine((value, ctx) => {
    if (value.kind === "bug" && value.expected.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `bug case "${value.id}" must list at least one expected defect`
      });
    }
    if (value.kind === "clean" && value.expected.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `clean case "${value.id}" must not list expected defects`
      });
    }
  });

export type BenchmarkCase = z.infer<typeof BenchmarkCaseSchema>;

/** Knobs controlling how predicted findings are matched to expected bugs. */
export interface MatchOptions {
  /**
   * Line tolerance: a finding within ±`lineWindow` lines of an expected bug's
   * range counts as a location match. Default {@link DEFAULT_LINE_WINDOW}.
   */
  lineWindow?: number;
  /**
   * When true, a finding must also share the expected bug's `category` (case-
   * insensitive) to match. Default false — location is the primary signal.
   */
  requireCategory?: boolean;
}

/** Default line tolerance for matching a finding to an expected bug. */
export const DEFAULT_LINE_WINDOW = 3;

/**
 * Per-case scoring outcome.
 *
 * Recall is bug-level (did a finding cover each known defect?); precision is
 * finding-level (did each finding hit a real defect?). Keeping the two notions
 * separate avoids the trap of conflating "bugs found" with "findings emitted"
 * when several findings land on one bug.
 */
export interface CaseResult {
  id: string;
  kind: CaseKind;
  /** Known defects in the case (0 for clean cases). */
  expectedBugs: number;
  /** Expected bugs matched by at least one finding (bug-level TP → recall). */
  coveredBugs: number;
  /** Expected bugs no finding matched (`expectedBugs - coveredBugs`). */
  falseNegatives: number;
  /** Total findings the reviewer produced for this case. */
  findings: number;
  /** Findings that matched at least one expected bug (finding-level TP → precision). */
  matchedFindings: number;
  /** Findings that matched no expected bug — noise (`findings - matchedFindings`). */
  falsePositives: number;
  /** True when the underlying review pass failed (case excluded from metrics). */
  errored: boolean;
  /** Set when `errored`. */
  error?: string;
}

/** Aggregate precision/recall/F1 + clean-PR noise across the benchmark. */
export interface EvalMetrics {
  /** Σ covered bugs across bug cases (numerator of recall). */
  coveredBugs: number;
  /** Σ expected bugs across bug cases (denominator of recall). */
  expectedBugs: number;
  /** Σ findings that hit a real defect (numerator of precision). */
  matchedFindings: number;
  /** Σ findings emitted across all cases (denominator of precision). */
  totalFindings: number;
  /** matchedFindings / totalFindings; 1 when there are no findings at all. */
  precision: number;
  /** coveredBugs / expectedBugs; 1 when there are no expected bugs at all. */
  recall: number;
  /** Harmonic mean of precision and recall; 0 when either is 0. */
  f1: number;
  /** Average findings per `clean` case (the false-alarm rate; lower is better). */
  cleanFalseAlarmRate: number;
  /** Number of clean cases scored. */
  cleanCases: number;
  /** Number of bug cases scored. */
  bugCases: number;
}

/** Review-pipeline settings that affect which findings survive into scoring. */
export interface EvalReviewSettings {
  /** Whether the false-positive verification pass ran. */
  verify: boolean;
  /** Effective minimum severity floor used by the judge. */
  minSeverity: Severity;
  /** Effective confidence floor for non-critical findings. */
  minConfidence: number;
  /** Effective cap on surfaced findings. */
  maxFindings: number;
  /** Effective confidence threshold above which findings skip verification. */
  verifyConfidence: number;
}

/** Effective risk-tier thresholds recorded for benchmark reproducibility. */
export interface EvalRiskTieringSettings {
  /** Whether tiering was enabled for the run. */
  enabled: boolean;
  /** Effective upper bounds for the cheap `minimal` tier. */
  minimal: { maxChangedLines: number; maxFiles: number };
  /** Effective lower bounds for the thorough `deep` tier. */
  deep: { minChangedLines: number; minFiles: number };
}

/** Risk-tier decision made for one benchmark case. */
export interface EvalRiskTierCase {
  /** Benchmark case id. */
  id: string;
  /** Tier selected after production-style guards. */
  tier: RiskTier;
  /** Changed-line signal used for selection. */
  changedLines: number;
  /** File-count signal used for selection. */
  fileCount: number;
  /** Built-in specialist keys used when the tier narrowed the default set. */
  specialistKeys?: string[];
}

/** Risk-tiering metadata that affects what each benchmark case exercised. */
export interface EvalRiskTieringReport {
  /** Effective tiering settings for this run. */
  settings: EvalRiskTieringSettings;
  /** Per-case tier decisions. Cases that fail before diff guarding are absent. */
  cases: EvalRiskTierCase[];
}

/** A full benchmark run, stamped for reproducibility. */
export interface EvalReport {
  /** Provider that produced the reviews. */
  provider: string;
  /** Model that produced the reviews. */
  model: string;
  /** Hash of the review prompts + specialist set (changes when prompts change). */
  promptFingerprint: string;
  /** Matching configuration used. */
  match: Required<MatchOptions>;
  /** Review settings that affect finding filtering and verification. */
  review: EvalReviewSettings;
  /** Risk-tiering settings and per-case decisions used by the runner. */
  riskTiering: EvalRiskTieringReport;
  metrics: EvalMetrics;
  cases: CaseResult[];
  /** Cases excluded from metrics because their review pass errored. */
  errored: number;
}
