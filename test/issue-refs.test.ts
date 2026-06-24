import { describe, expect, it } from "vitest";
import { parseIssueReferences, formatIssueRef } from "../src/review/issue-refs.js";

const repo = { owner: "prowl-tools", repo: "prowl-code-review" };

describe("parseIssueReferences", () => {
  it("links a same-repo issue via a closing keyword", () => {
    expect(parseIssueReferences("Closes #12", repo)).toEqual([{ ...repo, number: 12 }]);
    expect(parseIssueReferences("this fixes #7 finally", repo)).toEqual([{ ...repo, number: 7 }]);
  });

  it("accepts every GitHub closing keyword, case-insensitively", () => {
    for (const kw of ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"]) {
      expect(parseIssueReferences(`${kw.toUpperCase()} #3`, repo)).toEqual([{ ...repo, number: 3 }]);
    }
  });

  it("does NOT link a bare #n without a closing keyword (incidental mention)", () => {
    expect(parseIssueReferences("see #9 for context", repo)).toEqual([]);
  });

  it("links a cross-repo owner/repo#n reference", () => {
    expect(parseIssueReferences("Fixes octocat/Hello-World#42", repo)).toEqual([
      { owner: "octocat", repo: "Hello-World", number: 42 }
    ]);
  });

  it("links an explicit issue URL even without a keyword", () => {
    expect(parseIssueReferences("ref https://github.com/octo/repo/issues/5", repo)).toEqual([
      { owner: "octo", repo: "repo", number: 5 }
    ]);
  });

  it("dedupes references and preserves first-seen order", () => {
    const refs = parseIssueReferences("Closes #1\nfixes #2\nalso closes #1", repo);
    expect(refs).toEqual([
      { ...repo, number: 1 },
      { ...repo, number: 2 }
    ]);
  });

  it("preserves first-seen order across keyword and URL references", () => {
    const refs = parseIssueReferences(
      "see https://github.com/octo/repo/issues/5 before this closes #1",
      repo
    );
    expect(refs).toEqual([
      { owner: "octo", repo: "repo", number: 5 },
      { ...repo, number: 1 }
    ]);
  });

  it("returns [] for empty/missing text", () => {
    expect(parseIssueReferences("", repo)).toEqual([]);
    expect(parseIssueReferences(null, repo)).toEqual([]);
  });
});

describe("formatIssueRef", () => {
  it("renders same-repo as #n and cross-repo as owner/repo#n", () => {
    expect(formatIssueRef({ ...repo, number: 12 }, repo)).toBe("#12");
    expect(formatIssueRef({ owner: "octo", repo: "r", number: 5 }, repo)).toBe("octo/r#5");
  });
});
