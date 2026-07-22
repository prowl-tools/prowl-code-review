import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { BenchmarkCaseSchema, CASE_KINDS, ExpectedBugSchema, type BenchmarkCase } from "./types.js";

/**
 * Benchmark fixture loader (backlog #13).
 *
 * A benchmark directory holds one sub-directory per case:
 *
 *   bench/<id>/
 *     case.json      # { description, kind, expected[] }  (id defaults to <id>)
 *     input.diff     # the unified diff under review
 *     context.txt    # optional cross-file context
 *     guidelines.md  # optional per-case review guidelines
 *
 * Keeping the diff as a real `.diff` file (not a JSON-escaped string) makes
 * cases readable and hand-authorable. Everything is Zod-validated on load, so a
 * malformed fixture fails loudly instead of skewing the score.
 */

/** The metadata stored in each case's `case.json` (diff/context come from files). */
const CaseMetaSchema = z
  .object({
    /** Optional explicit id; defaults to the directory name. */
    id: z.string().min(1).optional(),
    description: z.string().min(1),
    kind: z.enum(CASE_KINDS),
    expected: z.array(ExpectedBugSchema).default([])
  })
  .superRefine((value, ctx) => {
    if (value.kind === "bug" && value.expected.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "bug case must list at least one expected defect",
        path: ["expected"]
      });
    }
    if (value.kind === "clean" && value.expected.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "clean case must not list expected defects",
        path: ["expected"]
      });
    }
  });

/** Read an optional text fixture file when the case provides it. */
function readIfPresent(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** Summarize Zod issues without dropping their field paths. */
function summarizeZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    })
    .join("; ");
}

/** Load and validate a single case directory. */
export function loadCase(caseDir: string, id: string): BenchmarkCase {
  const metaPath = join(caseDir, "case.json");
  if (!existsSync(metaPath)) {
    throw new Error(`Benchmark case "${id}" is missing case.json`);
  }
  let rawMeta: unknown;
  try {
    rawMeta = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch (error) {
    throw new Error(`Benchmark case "${id}" has invalid case.json: ${error instanceof Error ? error.message : error}`, {
      cause: error
    });
  }
  let meta: z.infer<typeof CaseMetaSchema>;
  try {
    meta = CaseMetaSchema.parse(rawMeta);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Benchmark case "${id}" has invalid case.json schema: ${summarizeZodError(error)}`, {
        cause: error
      });
    }
    throw error;
  }

  const diff = readIfPresent(join(caseDir, "input.diff"));
  if (!diff) {
    throw new Error(`Benchmark case "${id}" is missing input.diff`);
  }

  return BenchmarkCaseSchema.parse({
    id: meta.id ?? id,
    description: meta.description,
    kind: meta.kind,
    diff,
    context: readIfPresent(join(caseDir, "context.txt")),
    guidelines: readIfPresent(join(caseDir, "guidelines.md")),
    expected: meta.expected
  });
}

/** Load every case under a benchmark directory, sorted by id for determinism. */
export function loadBenchmark(dir: string): BenchmarkCase[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`Benchmark directory not found: ${dir}`);
  }
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const cases = entries.map((name) => loadCase(join(dir, name), name));

  const seen = new Set<string>();
  for (const benchmarkCase of cases) {
    if (seen.has(benchmarkCase.id)) {
      throw new Error(`Duplicate benchmark case id: ${benchmarkCase.id}`);
    }
    seen.add(benchmarkCase.id);
  }
  return cases;
}
