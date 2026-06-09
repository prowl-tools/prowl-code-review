import { describe, expect, it } from "vitest";
import { buildInlineComments, buildReviewPayload, formatFindingComment } from "../src/review/inline.js";
import type { ParsedDiff } from "../src/review/diff-types.js";
import type { Finding } from "../src/review/findings.js";

// One file whose new-side lines are 5 (context), 6 and 7 (added).
const diff: ParsedDiff = {
  files: [
    {
      path: "src/a.ts",
      status: "modified",
      binary: false,
      byteSize: 0,
      hunks: [
        {
          oldStart: 5,
          oldLines: 1,
          newStart: 5,
          newLines: 3,
          section: "",
          lines: [
            { type: "context", content: "a", oldLine: 5, newLine: 5 },
            { type: "add", content: "b", newLine: 6 },
            { type: "add", content: "c", newLine: 7 }
          ]
        }
      ]
    }
  ]
};

function f(over: Partial<Finding> = {}): Finding {
  return { file: "src/a.ts", line: 6, severity: "major", category: "correctness", title: "Title", body: "Body", confidence: 0.7, ...over };
}

describe("buildInlineComments", () => {
  it("anchors a finding to a new-side diff line", () => {
    const { comments, unmapped } = buildInlineComments([f({ line: 6 })], diff);
    expect(unmapped).toHaveLength(0);
    expect(comments[0]).toMatchObject({ path: "src/a.ts", line: 6, side: "RIGHT" });
    expect(comments[0].body).toContain("Title");
  });

  it("leaves findings unmapped when the line/file isn't in the diff or no line is given", () => {
    const { comments, unmapped } = buildInlineComments(
      [f({ line: 99 }), f({ file: "other.ts", line: 1 }), f({ line: undefined })],
      diff
    );
    expect(comments).toHaveLength(0);
    expect(unmapped).toHaveLength(3);
  });

  it("builds a multi-line range when endLine is also in the diff", () => {
    const { comments } = buildInlineComments([f({ line: 6, endLine: 7 })], diff);
    expect(comments[0]).toMatchObject({
      path: "src/a.ts",
      start_line: 6,
      start_side: "RIGHT",
      line: 7,
      side: "RIGHT"
    });
  });

  it("keeps a multi-line finding single-line when it spans two diff hunks", () => {
    const splitHunkDiff: ParsedDiff = {
      files: [
        {
          path: "src/a.ts",
          status: "modified",
          binary: false,
          byteSize: 0,
          hunks: [
            {
              oldStart: 5,
              oldLines: 2,
              newStart: 5,
              newLines: 2,
              section: "",
              lines: [
                { type: "context", content: "a", oldLine: 5, newLine: 5 },
                { type: "add", content: "b", newLine: 6 }
              ]
            },
            {
              oldStart: 50,
              oldLines: 2,
              newStart: 50,
              newLines: 2,
              section: "",
              lines: [
                { type: "context", content: "y", oldLine: 50, newLine: 50 },
                { type: "add", content: "z", newLine: 51 }
              ]
            }
          ]
        }
      ]
    };

    const { comments, unmapped } = buildInlineComments([f({ line: 6, endLine: 51 })], splitHunkDiff);

    expect(unmapped).toHaveLength(0);
    expect(comments[0]).toMatchObject({ path: "src/a.ts", line: 6, side: "RIGHT" });
    expect(comments[0]).not.toHaveProperty("start_line");
    expect(comments[0]).not.toHaveProperty("start_side");
  });

  it("keeps a multi-line finding single-line when the range endpoint is missing from the hunk", () => {
    const { comments } = buildInlineComments([f({ line: 5, endLine: 8 })], diff);

    expect(comments[0]).toMatchObject({ path: "src/a.ts", line: 5, side: "RIGHT" });
    expect(comments[0]).not.toHaveProperty("start_line");
    expect(comments[0]).not.toHaveProperty("start_side");
  });
});

describe("formatFindingComment", () => {
  it("renders a severity badge and title", () => {
    const body = formatFindingComment(f({ severity: "critical", title: "SQLi" }));
    expect(body).toContain("🔴");
    expect(body).toContain("[critical] SQLi");
    expect(body).toContain("Body");
  });

  it("includes a committable suggestion block when a fix exists", () => {
    const body = formatFindingComment(f({ suggestion: "const x = 1;" }));
    expect(body).toContain("```suggestion");
    expect(body).toContain("const x = 1;");
  });

  it("widens the suggestion fence when the fix contains a code fence", () => {
    const body = formatFindingComment(f({ suggestion: "before\n```\nafter" }));
    expect(body).toContain("````suggestion");
  });

  it("omits the suggestion block when there is no fix", () => {
    expect(formatFindingComment(f())).not.toContain("```suggestion");
  });
});

describe("buildReviewPayload", () => {
  it("uses the summary as the body, defaults to COMMENT, and includes mapped comments", () => {
    const payload = buildReviewPayload({ findings: [f({ line: 6 })], diff, summaryBody: "## walkthrough" });
    expect(payload.body).toBe("## walkthrough");
    expect(payload.event).toBe("COMMENT");
    expect(payload.comments).toHaveLength(1);
  });

  it("respects an explicit event", () => {
    const payload = buildReviewPayload({ findings: [], diff, summaryBody: "x", event: "REQUEST_CHANGES" });
    expect(payload.event).toBe("REQUEST_CHANGES");
  });
});
