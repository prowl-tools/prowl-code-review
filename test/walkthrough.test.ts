import { describe, expect, it } from "vitest";
import {
  buildWalkthrough,
  reviewCommentState,
  severityCounts,
  deriveImpact,
  deriveEffort,
  REVIEW_MARKER
} from "../src/review/walkthrough.js";
import type { DiffFile } from "../src/review/diff-types.js";
import type { Finding, Severity } from "../src/review/findings.js";

function makeFile(path: string, adds: number, dels: number, opts: Partial<DiffFile> = {}): DiffFile {
  const lines = [
    ...Array.from({ length: adds }, (_, i) => ({ type: "add" as const, content: "x", newLine: i + 1 })),
    ...Array.from({ length: dels }, (_, i) => ({ type: "del" as const, content: "y", oldLine: i + 1 }))
  ];
  return {
    path,
    status: "modified",
    binary: false,
    byteSize: 0,
    hunks: [{ oldStart: 1, oldLines: dels, newStart: 1, newLines: adds, section: "", lines }],
    ...opts
  };
}

function makeFinding(severity: Severity, over: Partial<Finding> = {}): Finding {
  return { file: "src/a.ts", line: 5, severity, category: "correctness", title: "Issue", body: "b", confidence: 0.5, ...over };
}

describe("severityCounts", () => {
  it("counts by severity including zeros", () => {
    const counts = severityCounts([makeFinding("critical"), makeFinding("critical"), makeFinding("minor")]);
    expect(counts.critical).toBe(2);
    expect(counts.minor).toBe(1);
    expect(counts.info).toBe(0);
  });
});

describe("deriveImpact", () => {
  it("is high when any critical finding exists", () => {
    expect(deriveImpact([makeFinding("critical")], [])).toBe("high");
  });
  it("is medium for a major finding or a large diff", () => {
    expect(deriveImpact([makeFinding("major")], [])).toBe("medium");
    expect(deriveImpact([], [makeFile("a.ts", 500, 0)])).toBe("medium");
  });
  it("is low otherwise", () => {
    expect(deriveImpact([makeFinding("minor")], [makeFile("a.ts", 3, 1)])).toBe("low");
  });
});

describe("deriveEffort", () => {
  it("scales with change size", () => {
    expect(deriveEffort([makeFile("a.ts", 2, 0)])).toBe(1);
    expect(deriveEffort([makeFile("a.ts", 100, 0)])).toBe(3);
    expect(deriveEffort([makeFile("a.ts", 700, 0)])).toBe(5);
  });
});

describe("buildWalkthrough", () => {
  const files = [makeFile("src/a.ts", 12, 3), makeFile("README.md", 2, 1)];

  it("includes the marker, header, and provided summary", () => {
    const md = buildWalkthrough({ findings: [makeFinding("major")], files, summary: "Adds caching to auth." });
    expect(md.startsWith(REVIEW_MARKER)).toBe(true);
    expect(md).toContain("## prowl-review");
    expect(md).toContain("Adds caching to auth.");
  });

  it("falls back to a default summary when none is given (findings state)", () => {
    const md = buildWalkthrough({ findings: [makeFinding("major")], files });
    expect(md).toContain("Automated review of the changes");
  });

  it("renders impact/effort/severity badges from findings", () => {
    const md = buildWalkthrough({
      findings: [makeFinding("critical"), makeFinding("major", { file: "src/b.ts" })],
      files
    });
    expect(md).toContain("**Impact:** 🔴 High");
    expect(md).toMatch(/Estimated effort:\*\* \d\/5/);
    expect(md).toContain("🔴 1");
    expect(md).toContain("🟠 1");
  });

  it("groups changed files by top directory inside a collapsed details block", () => {
    const md = buildWalkthrough({ findings: [], files });
    // The file inventory is collapsed behind <details>, not a top-level heading (#54).
    expect(md).not.toContain("### Changed files");
    expect(md).toContain("<summary><b>Changed files (2)</b></summary>");
    expect(md).toContain("<details>");
    expect(md).toContain("</details>");
    expect(md).toContain("**src/**");
    expect(md).toContain("`src/a.ts` — modified (+12 −3)");
    expect(md).toContain("**(root)/**");
    // Blank line after <summary> so the Markdown list renders inside the block.
    expect(md).toContain("</summary>\n\n**");
  });

  it("renders an empty changed-files list inside a collapsed details block", () => {
    const md = buildWalkthrough({ findings: [], files: [] });
    expect(md).not.toContain("### Changed files");
    expect(md).toContain("<summary><b>Changed files (0)</b></summary>");
    expect(md).toContain("_None._");
  });

  it("escapes untrusted review text before rendering Markdown", () => {
    const md = buildWalkthrough({
      summary: "Looks fine @org/team.\n- list item\n1. ordered\n### Spoof\n<!-- hidden -->\n> quote",
      findings: [
        makeFinding("major", {
          file: "findings/`bad`\n### injected.md",
          title: "Title **break**\n- list item\n1. ordered\n### fake @org/team"
        })
      ],
      files: [makeFile("src/`spoof`\n### fake.md", 1, 0)],
      skipped: [{ path: "skip/`bad`\n### skipped.md", reason: "maxFiles" }]
    });

    expect(md).toContain("``src/`spoof`\\n### fake.md``");
    expect(md).toContain("``findings/`bad`\\n### injected.md:5``");
    expect(md).toContain("``skip/`bad`\\n### skipped.md``");
    expect(md).toContain("Title \\*\\*break\\*\\* \\- list item 1\\. ordered \\#\\#\\# fake &#64;org/team");
    expect(md).toContain("Looks fine &#64;org/team. \\- list item 1\\. ordered \\#\\#\\# Spoof &lt;\\!-- hidden --&gt; &gt; quote");
    expect(md).not.toContain("`spoof`\n### fake.md");
    expect(md).not.toContain("`bad`\n### injected.md");
    expect(md).not.toContain("`bad`\n### skipped.md");
    expect(md).not.toContain("Title **break**\n### fake @org/team");
    expect(md).not.toContain("\n- list item");
    expect(md).not.toContain("\n1. ordered");
    expect(md).not.toContain("Looks fine @org/team.\n### Spoof");
    expect(md).not.toContain("<!-- hidden -->");
    expect(md).not.toContain("@org/team");
  });

  it("marks binary files instead of showing line deltas", () => {
    const md = buildWalkthrough({ findings: [], files: [makeFile("img.png", 0, 0, { binary: true, hunks: [] })] });
    expect(md).toContain("`img.png` — modified (binary)");
  });

  it("lists blocking findings prominently and nitpicks in a collapsed section (#58)", () => {
    const md = buildWalkthrough({
      findings: [makeFinding("critical", { title: "SQLi" }), makeFinding("minor", { title: "nit" })],
      files
    });
    // Blocking finding in the prominent list; nitpick tucked into the collapsed section.
    expect(md).toContain("### Findings");
    expect(md).toContain("**SQLi**");
    expect(md).toContain("🧹 Nitpicks (1)");
    expect(md).toContain("**nit**");
    // The nitpick comes after the Findings header, not above it.
    expect(md.indexOf("### Findings")).toBeLessThan(md.indexOf("Nitpicks"));
  });

  it("notes findings-free reviews", () => {
    const md = buildWalkthrough({ findings: [makeFinding("minor")], files });
    expect(md).toContain("_No blocking issues found._");
  });

  it("reports skipped files (no silent truncation)", () => {
    const md = buildWalkthrough({
      findings: [],
      files,
      skipped: [{ path: "huge.lock", reason: "maxDiffBytes" }]
    });
    expect(md).toContain("Not reviewed");
    expect(md).toContain("huge.lock");
  });

  it("renders review notes safely", () => {
    const md = buildWalkthrough({
      findings: [makeFinding("major")],
      files,
      notes: ["Reached limit @org/team\n* injected item\n<!-- <details>spoof</details> -->\n### injected"]
    });

    expect(md).toContain("Review notes");
    expect(md).toContain("Reached limit &#64;org/team \\* injected item &lt;\\!-- &lt;details&gt;spoof&lt;/details&gt; --&gt; \\#\\#\\# injected");
    expect(md).not.toContain("@org/team");
    expect(md).not.toContain("<!-- <details>spoof</details> -->");
    expect(md).not.toContain("<details>spoof</details>");
    expect(md).not.toContain("\n* injected item");
    expect(md).not.toContain("\n### injected");
  });

  it("renders a mermaid block only when provided", () => {
    const withDiagram = buildWalkthrough({ findings: [], files, mermaid: "graph TD; A-->B" });
    expect(withDiagram).toContain("```mermaid");
    expect(withDiagram).toContain("A-->B");
    const without = buildWalkthrough({ findings: [], files });
    expect(without).not.toContain("```mermaid");
  });

  it("uses a longer mermaid fence when the body contains backticks", () => {
    const md = buildWalkthrough({
      findings: [],
      files,
      mermaid: "graph TD; A-->B\n```\n### fake"
    });

    expect(md).toContain("````mermaid\ngraph TD; A-->B\n```\n### fake\n````");
  });

  describe("comment states (#56)", () => {
    it("renders a compact clean state when healthy with no findings", () => {
      const md = buildWalkthrough({ findings: [], files, coverage: { passed: 4, total: 4 } });
      expect(md).toContain("✅ No issues found 🦝");
      // Review info is collapsed, with the pass count.
      expect(md).toContain("<summary><b>Review info</b></summary>");
      expect(md).toContain("4/4 passes");
      expect(md).toContain("<summary><b>Changed files (2)</b></summary>");
      // None of the verbose findings-state chrome.
      expect(md).not.toContain("**Impact:**");
      expect(md).not.toContain("### Findings");
      expect(md).not.toContain("No blocking issues found");
      expect(md).not.toContain("Findings:");
    });

    it("stays clean with a caveat headline when files were skipped (#56)", () => {
      const md = buildWalkthrough({
        findings: [],
        files,
        coverage: { passed: 4, total: 4 },
        skipped: [{ path: "huge.lock", reason: "maxDiffBytes" }]
      });
      // Partial coverage on a healthy review: clean + honest caveat, not degraded.
      expect(md).toContain("✅ No issues found in reviewed files 🦝");
      expect(md).toContain("Not reviewed");
      expect(md).toContain("huge.lock");
      expect(md).not.toContain("Review incomplete");
    });

    it("folds clean-state notes safely into review info, not a warning callout", () => {
      const md = buildWalkthrough({
        findings: [],
        files,
        coverage: { passed: 4, total: 4 },
        notes: ["Redacted 1 secret(s) from src/a.ts", "Reached limit @org/team\n<!-- hidden -->\n### injected"]
      });
      expect(md).toContain("✅ No issues found");
      expect(md).toContain("Redacted 1 secret");
      expect(md).toContain("Reached limit &#64;org/team &lt;\\!-- hidden --&gt; \\#\\#\\# injected");
      expect(md).not.toContain("⚠️ **Review notes**");
      expect(md).not.toContain("@org/team");
      expect(md).not.toContain("<!-- hidden -->");
      expect(md).not.toContain("\n### injected");
    });

    it("renders a degraded state that never looks like a clean pass", () => {
      const md = buildWalkthrough({
        findings: [],
        files,
        degraded: true,
        coverage: { passed: 1, total: 4 },
        notes: ['Review pass "correctness" failed: Gemini API returned no content']
      });
      expect(md).toContain("⚠️ **Review incomplete** — 3/4 specialist passes failed");
      expect(md).toContain("Gemini API returned no content");
      // Must NOT masquerade as clean.
      expect(md).not.toContain("No issues found");
      expect(md).not.toContain("Findings: none");
      expect(md).not.toContain("✅");
    });

    it("derives degraded state from partial coverage without an explicit flag", () => {
      const md = buildWalkthrough({
        findings: [],
        files,
        coverage: { passed: 3, total: 4 }
      });
      expect(md).toContain("⚠️ **Review incomplete** — 1/4 specialist passes failed");
      expect(md).not.toContain("No issues found");
    });

    it("renders a generic degraded header when passes are ok but degraded is true", () => {
      const md = buildWalkthrough({
        findings: [],
        files,
        degraded: true,
        coverage: { passed: 4, total: 4 }
      });
      expect(md).toContain("⚠️ **Review incomplete** — coverage degraded");
      expect(md).not.toContain("specialist passes failed");
      expect(md).not.toContain("No issues found");
    });

    it("shows the full findings report even when also degraded", () => {
      const md = buildWalkthrough({
        findings: [makeFinding("critical", { title: "SQLi" })],
        files,
        degraded: true,
        coverage: { passed: 3, total: 4 }
      });
      expect(md).toContain("**Impact:**");
      expect(md).toContain("**SQLi**");
      expect(md).not.toContain("Review incomplete");
    });
  });

  describe("reviewCommentState", () => {
    it("prefers findings, then degraded, then clean", () => {
      expect(reviewCommentState({ findings: [makeFinding("minor")], files })).toBe("findings");
      expect(reviewCommentState({ findings: [makeFinding("minor")], files, degraded: true })).toBe("findings");
      expect(reviewCommentState({ findings: [], files, degraded: true })).toBe("degraded");
      expect(reviewCommentState({ findings: [], files, coverage: { passed: 3, total: 4 } })).toBe("degraded");
      // Skipped files are partial coverage on a healthy review → clean (caveat), not degraded (#56).
      expect(reviewCommentState({ findings: [], files, skipped: [{ path: "huge.lock", reason: "maxDiffBytes" }] })).toBe("clean");
      expect(reviewCommentState({ findings: [], files })).toBe("clean");
    });
  });
});
