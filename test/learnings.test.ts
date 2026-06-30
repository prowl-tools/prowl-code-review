import { describe, expect, it } from "vitest";
import {
  parseLearnings,
  serializeLearnings,
  mergeLearnings,
  renderLearningsIssueBody,
  learningFingerprints,
  emptyLearnings,
  REPO_LEARNINGS_VERSION,
  LEARNINGS_ISSUE_TITLE,
  MAX_LEARNED_PATTERNS,
  type RepoLearnings
} from "../src/review/learnings.js";
import { GITHUB_COMMENT_BODY_LIMIT } from "../src/review/state.js";

describe("serializeLearnings / parseLearnings round-trip", () => {
  const store: RepoLearnings = {
    v: REPO_LEARNINGS_VERSION,
    patterns: [
      { fp: "aaaa1111", label: "Off-by-one in loop bound" },
      { fp: "bbbb2222" }
    ]
  };

  it("round-trips through the hidden marker", () => {
    expect(parseLearnings(serializeLearnings(store))).toEqual(store);
  });

  it("keeps marker boundaries intact when labels contain comment-like text", () => {
    const state: RepoLearnings = {
      v: REPO_LEARNINGS_VERSION,
      patterns: [{ fp: "aaaa1111", label: "Text with --> inside" }]
    };
    expect(parseLearnings(serializeLearnings(state))).toEqual(state);
  });

  it("finds the marker embedded in a rendered issue body", () => {
    const body = renderLearningsIssueBody(store);
    expect(parseLearnings(body)).toEqual(store);
  });

  it("returns null for missing/markerless bodies", () => {
    expect(parseLearnings(null)).toBeNull();
    expect(parseLearnings("")).toBeNull();
    expect(parseLearnings("just a normal issue")).toBeNull();
  });

  it("returns null for malformed or schema-invalid markers (graceful fallback)", () => {
    expect(parseLearnings("<!-- prowl-review:learnings {not json} -->")).toBeNull();
    expect(parseLearnings('<!-- prowl-review:learnings {"v":2,"patterns":[]} -->')).toBeNull();
    expect(parseLearnings('<!-- prowl-review:learnings {"v":1,"patterns":[{"nope":1}]} -->')).toBeNull();
  });

  it("defaults patterns to an empty array when omitted", () => {
    expect(parseLearnings('<!-- prowl-review:learnings {"v":1} -->')).toEqual({ v: 1, patterns: [] });
  });

  it("treats the visible list as the editable source of truth", () => {
    const body = renderLearningsIssueBody(store).replace("- `aaaa1111` — Off-by-one in loop bound\n", "");
    expect(parseLearnings(body)?.patterns).toEqual([{ fp: "bbbb2222" }]);
  });

  it("parses only visible learned-pattern bullet fingerprints from the editable section", () => {
    const persisted: RepoLearnings = {
      v: REPO_LEARNINGS_VERSION,
      patterns: [
        { fp: "keep", label: "Keep muted" },
        { fp: "drop", label: "Drop muted" },
        { fp: "hidden", label: "Hidden muted" }
      ]
    };
    const body = [
      "# prowl-review: learned patterns",
      "",
      "## Muted patterns (2)",
      "",
      "- `keep` — Keep muted",
      "Plain text with `hidden` should not count.",
      "- `drop` — Drop muted",
      "",
      serializeLearnings(persisted)
    ].join("\n");

    expect(parseLearnings(body)?.patterns).toEqual([
      { fp: "keep", label: "Keep muted" },
      { fp: "drop", label: "Drop muted" }
    ]);
  });
});

describe("mergeLearnings", () => {
  it("adds new fingerprints and reports the count", () => {
    const { learnings, added } = mergeLearnings(emptyLearnings(), [
      { fp: "aaaa", label: "A" },
      { fp: "bbbb", label: "B" }
    ]);
    expect(added).toBe(2);
    expect(learningFingerprints(learnings)).toEqual(["aaaa", "bbbb"]);
  });

  it("de-duplicates by fingerprint and counts only net-new", () => {
    const prior: RepoLearnings = { v: REPO_LEARNINGS_VERSION, patterns: [{ fp: "aaaa", label: "A" }] };
    const { learnings, added } = mergeLearnings(prior, [
      { fp: "aaaa", label: "A" },
      { fp: "cccc", label: "C" }
    ]);
    expect(added).toBe(1);
    expect(learningFingerprints(learnings)).toEqual(["aaaa", "cccc"]);
  });

  it("refreshes an existing entry's label in place without reordering", () => {
    const prior: RepoLearnings = {
      v: REPO_LEARNINGS_VERSION,
      patterns: [
        { fp: "aaaa", label: "old" },
        { fp: "bbbb", label: "keep" }
      ]
    };
    const { learnings, added } = mergeLearnings(prior, [{ fp: "aaaa", label: "new" }]);
    expect(added).toBe(0);
    expect(learnings.patterns).toEqual([
      { fp: "aaaa", label: "new" },
      { fp: "bbbb", label: "keep" }
    ]);
  });

  it("caps the store at MAX_LEARNED_PATTERNS, dropping the oldest", () => {
    const prior: RepoLearnings = {
      v: REPO_LEARNINGS_VERSION,
      patterns: Array.from({ length: MAX_LEARNED_PATTERNS }, (_unused, index) => ({ fp: `fp-${index}` }))
    };
    const { learnings } = mergeLearnings(prior, [{ fp: "newest" }]);
    expect(learnings.patterns).toHaveLength(MAX_LEARNED_PATTERNS);
    expect(learningFingerprints(learnings)).not.toContain("fp-0");
    expect(learningFingerprints(learnings)).toContain("newest");
  });
});

describe("renderLearningsIssueBody", () => {
  it("renders a human-readable list with labels and carries the marker", () => {
    const body = renderLearningsIssueBody({
      v: REPO_LEARNINGS_VERSION,
      patterns: [{ fp: "aaaa1111", label: "Null deref in foo" }]
    });
    expect(body).toContain(LEARNINGS_ISSUE_TITLE);
    expect(body).toContain("`aaaa1111` — Null deref in foo");
    expect(parseLearnings(body)?.patterns).toEqual([{ fp: "aaaa1111", label: "Null deref in foo" }]);
  });

  it("notes when no patterns are stored", () => {
    const body = renderLearningsIssueBody(emptyLearnings());
    expect(body).toContain("No learned patterns yet");
    expect(parseLearnings(body)).toEqual(emptyLearnings());
  });

  it("fits prose and marker together within the comment body limit, dropping oldest", () => {
    const patterns = Array.from({ length: 5000 }, (_unused, index) => ({
      fp: `fp-${index}`,
      label: `A reasonably long finding label number ${index} to push the body past the limit`
    }));
    const body = renderLearningsIssueBody({ v: REPO_LEARNINGS_VERSION, patterns });
    expect(body.length).toBeLessThanOrEqual(GITHUB_COMMENT_BODY_LIMIT);
    // The visible list and the persisted marker agree (both were fitted together).
    const parsed = parseLearnings(body);
    const visibleCount = (body.match(/^- `fp-/gm) ?? []).length;
    expect(parsed?.patterns.length).toBe(visibleCount);
    // Oldest dropped, newest kept.
    expect(learningFingerprints(parsed)).toContain("fp-4999");
    expect(learningFingerprints(parsed)).not.toContain("fp-0");
    const retained = learningFingerprints(parsed);
    const firstRetained = Number(retained[0].replace("fp-", ""));
    expect(retained).toEqual(
      Array.from({ length: retained.length }, (_unused, index) => `fp-${firstRetained + index}`)
    );
  });

  it("terminates cleanly when no single pattern can fit", () => {
    const body = renderLearningsIssueBody({
      v: REPO_LEARNINGS_VERSION,
      patterns: [{ fp: "too-large", label: "x".repeat(GITHUB_COMMENT_BODY_LIMIT) }]
    });

    expect(body.length).toBeLessThanOrEqual(GITHUB_COMMENT_BODY_LIMIT);
    expect(parseLearnings(body)).toEqual(emptyLearnings());
  });

  it("keeps a single fitting pattern without entering the drop path", () => {
    const state = { v: REPO_LEARNINGS_VERSION, patterns: [{ fp: "single", label: "Fits" }] };
    const body = renderLearningsIssueBody(state);
    expect(parseLearnings(body)).toEqual(state);
  });
});
