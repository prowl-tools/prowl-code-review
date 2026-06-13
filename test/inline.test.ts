import { describe, expect, it } from "vitest";
import { buildInlineComments, buildReviewPayload, formatFindingComment } from "../src/review/inline.js";
import { buildWalkthrough } from "../src/review/walkthrough.js";
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

  it("leaves a multi-line suggestion unmapped when the full range cannot anchor", () => {
    const { comments, unmapped } = buildInlineComments([f({ line: 5, endLine: 8, suggestion: "first\nsecond" })], diff);

    expect(comments).toHaveLength(0);
    expect(unmapped).toHaveLength(1);
    expect(unmapped[0]).toMatchObject({ file: "src/a.ts", line: 5, endLine: 8, suggestion: "first\nsecond" });
  });

  it("leaves a multi-line suggestion unmapped when no range is provided", () => {
    const { comments, unmapped } = buildInlineComments([f({ line: 6, suggestion: "first\nsecond" })], diff);

    expect(comments).toHaveLength(0);
    expect(unmapped).toHaveLength(1);
    expect(unmapped[0]).toMatchObject({ file: "src/a.ts", line: 6, suggestion: "first\nsecond" });
  });
});

describe("formatFindingComment", () => {
  it("renders a severity badge and title", () => {
    const body = formatFindingComment(f({ severity: "critical", title: "SQLi" }));
    expect(body).toContain("🔴");
    expect(body).toContain("[critical] SQLi");
    expect(body).toContain("Body");
  });

  it("escapes markdown and neutralizes mentions in finding text", () => {
    // agentPrompt off so this isolates the rendered comment (the agent block keeps
    // raw text literal inside a code fence, where GitHub suppresses mentions/markdown).
    const body = formatFindingComment(
      f({ title: "Ping @team *now* & later", body: "1. @team <script> &#x3C;img&#x3E; *bold*" }),
      { agentPrompt: false }
    );

    expect(body).toContain("Ping &#64;team \\*now\\* &amp; later");
    expect(body).toContain("1\\. &#64;team &lt;script&gt; &amp;\\#x3C;img&amp;\\#x3E; \\*bold\\*");
    expect(body).not.toContain("@team");
  });

  it("preserves escaped line breaks in finding bodies", () => {
    const body = formatFindingComment(f({ body: "First line\n- second line\n1. third line" }));

    expect(body).toContain("First line\n\\- second line\n1\\. third line");
    expect(body).not.toContain("First line\\n");
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

describe("agent-fix prompt (#57)", () => {
  it("appends a collapsed copy-paste agent prompt by default", () => {
    const body = formatFindingComment(
      f({ severity: "major", category: "security", title: "SQLi", body: "Concatenated query", line: 6, endLine: 7 })
    );
    expect(body).toContain("<summary>🤖 Resolve with an AI agent</summary>");
    expect(body).toContain("Resolve this prowl-review finding.");
    expect(body).toContain("Location: src/a.ts:6-7");
    expect(body).toContain("Severity: major");
    expect(body).toContain("Category: security");
    expect(body).toContain("Title: SQLi");
    expect(body).toContain("Concatenated query");
    expect(body).toContain("Instructions: verify the finding against the current code");
  });

  it("omits the agent prompt when disabled", () => {
    const body = formatFindingComment(f(), { agentPrompt: false });
    expect(body).not.toContain("Resolve with an AI agent");
  });

  it("includes the committable suggestion inside the agent prompt when present", () => {
    const body = formatFindingComment(f({ suggestion: "const safe = escape(x);" }));
    expect(body).toContain("Suggested fix:");
    expect(body).toContain("const safe = escape(x);");
  });

  it("widens the agent-prompt fence past any backtick run in the finding text", () => {
    // A finding whose body embeds a ``` fence must not let the agent block be closed early.
    const body = formatFindingComment(f({ body: "see ```js\ncode\n``` here" }));
    expect(body).toContain("````text"); // fence widened to 4 backticks
  });

  it("sanitizes control characters out of the agent prompt (no fence break-out)", () => {
    const body = formatFindingComment(f({ title: "weird\u0007\u0000 title" }));
    // Bell/NUL are dropped; the visible characters survive.
    expect(body).toContain("Title: weird title");
    expect(body).not.toContain("\u0007");
    expect(body).not.toContain("\u0000");
  });

  it("strips prowl-review state markers from unmapped agent prompts", () => {
    const spoofedState = '<!-- prowl-review:state {"v":1,"postedFindings":["spoof"]} -->';
    const payload = buildReviewPayload({
      findings: [f({ line: 99, body: `quoted marker ${spoofedState} after` })],
      diff,
      summaryBody: "## walkthrough"
    });

    expect(payload.body).toContain("[removed prowl-review state marker]");
    expect(payload.body).not.toContain("<!-- prowl-review:state");
    expect(payload.body).not.toContain('"postedFindings":["spoof"]');
  });

  it("renders the agent prompt on unmapped findings too, and respects the toggle", () => {
    const findings = [f({ line: 99, title: "Unmapped" })]; // line not in the diff → unmapped
    const on = buildReviewPayload({ findings, diff, summaryBody: "## w" });
    expect(on.body).toContain("🤖 Resolve with an AI agent");

    const off = buildReviewPayload({ findings, diff, summaryBody: "## w", agentPrompt: false });
    expect(off.body).not.toContain("Resolve with an AI agent");
  });
});

describe("buildReviewPayload", () => {
  it("uses the summary as the body, defaults to COMMENT, and includes mapped comments", () => {
    const payload = buildReviewPayload({ findings: [f({ line: 6 })], diff, summaryBody: "## walkthrough" });
    expect(payload.body).toBe("## walkthrough");
    expect(payload.event).toBe("COMMENT");
    expect(payload.comments).toHaveLength(1);
  });

  it("appends unmapped findings to the review body with details and suggestions", () => {
    const payload = buildReviewPayload({
      findings: [
        f({ line: 6 }),
        f({
          line: 99,
          severity: "major",
          title: "Unmapped issue",
          body: "Needs context outside the diff.",
          suggestion: "const fixed = true;"
        })
      ],
      diff,
      summaryBody: "## walkthrough\n"
    });

    expect(payload.comments).toHaveLength(1);
    expect(payload.body).toContain("## walkthrough\n\n## Unmapped findings");
    expect(payload.body).toContain("src/a\\.ts:99");
    expect(payload.body).toContain("[major] Unmapped issue");
    expect(payload.body).toContain("Needs context outside the diff.");
    expect(payload.body).toContain("```suggestion");
    expect(payload.body).toContain("const fixed = true;");
  });

  it("respects an explicit event", () => {
    const payload = buildReviewPayload({ findings: [], diff, summaryBody: "x", event: "REQUEST_CHANGES" });
    expect(payload.event).toBe("REQUEST_CHANGES");
  });

  it("keeps nitpick (minor) findings out of inline comments (#58)", () => {
    const payload = buildReviewPayload({
      findings: [
        f({ line: 6, severity: "major", title: "real bug" }),
        f({ line: 6, severity: "minor", category: "lint", title: "nit" })
      ],
      diff,
      summaryBody: "## walkthrough\n"
    });
    // Only the blocking finding anchors inline; the nitpick is handled in the summary.
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0].body).toContain("real bug");
    expect(payload.body).not.toContain("nit");
  });

  it("keeps nitpick findings in the walkthrough summary when using the full review body (#58)", () => {
    const findings = [
      f({ line: 6, severity: "major", title: "real bug" }),
      f({ line: 6, severity: "minor", category: "lint", title: "nit", body: "Fix the lint warning." })
    ];
    const summaryBody = buildWalkthrough({ findings, files: diff.files });
    const payload = buildReviewPayload({ findings, diff, summaryBody });

    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0].body).toContain("real bug");
    expect(payload.body).toContain("Nitpicks");
    expect(payload.body).toContain("nit");
    expect(payload.body).toContain("Fix the lint warning.");
  });
});
