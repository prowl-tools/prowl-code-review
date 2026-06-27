import { describe, expect, it } from "vitest";
import { sanitizeGitHubMarkdown } from "../src/review/markdown-sanitize.js";

describe("sanitizeGitHubMarkdown", () => {
  it("preserves ordinary Markdown while defanging raw HTML, encoded tags, and mentions", () => {
    const sanitized = sanitizeGitHubMarkdown(
      [
        "**bold** and `code`",
        "<img src=x onerror=alert(1)>",
        "&#x3c;script&#x3e;alert(1)&#x3c;/script&#x3e;",
        "@team and user@example.com"
      ].join("\n")
    );

    expect(sanitized).toContain("**bold** and `code`");
    expect(sanitized).not.toContain("<img");
    expect(sanitized).not.toContain("<script");
    expect(sanitized).toContain("&lt;img src=x onerror=alert(1)>");
    expect(sanitized).toContain("&amp;#x3c;script&amp;#x3e;alert(1)");
    expect(sanitized).toContain("&#64;team and user&#64;example.com");
  });

  it("blocks unsafe inline and reference link protocols", () => {
    const sanitized = sanitizeGitHubMarkdown(
      [
        "[direct](javascript:alert(1))",
        "[data](data:text/html,<script>)",
        "[ref]: vbscript:msgbox(1)"
      ].join("\n")
    );

    expect(sanitized).toContain("[direct](#blocked-alert(1))");
    expect(sanitized).toContain("[data](#blocked-text/html,&lt;script>)");
    expect(sanitized).toContain("[ref]: #blocked-msgbox(1)");
    expect(sanitized).not.toMatch(/\]\(\s*(?:javascript|data|vbscript)\s*:/i);
    expect(sanitized).not.toMatch(/^\s*\[[^\]]+\]:\s*(?:javascript|data|vbscript)\s*:/im);
  });

  it("blocks encoded and normalized unsafe link protocols", () => {
    const sanitized = sanitizeGitHubMarkdown(
      [
        "[percent](java%73cript%3Aalert(1))",
        "[entity](&#x6a;&#97;vascript:alert(1))",
        "[fullwidth](ｄａｔａ:text/html,boom)",
        "[ref]: vb%73cript%3Amsgbox(1)"
      ].join("\n")
    );

    expect(sanitized).toContain("[percent](#blocked-java%73cript%3Aalert");
    expect(sanitized).toContain("[entity](#blocked-&amp;#x6a;&amp;#97;vascript:alert");
    expect(sanitized).toContain("[fullwidth](#blocked-ｄａｔａ:text/html,boom)");
    expect(sanitized).toContain("[ref]: #blocked-vb%73cript%3Amsgbox(1)");
    expect(sanitized).not.toMatch(/\]\(\s*(?:javascript|data|vbscript|java%73cript|&#x6a;|ｄａｔａ)/i);
    expect(sanitized).not.toMatch(/^\s*\[[^\]]+\]:\s*(?:javascript|data|vbscript|vb%73cript)/im);
  });

  it("preserves safe links and whitelisted HTML entities", () => {
    const sanitized = sanitizeGitHubMarkdown(
      "See [docs](https://example.com?a=1&b=2), [relative](./guide.md), and &amp; &lt; &gt;."
    );

    expect(sanitized).toBe(
      "See [docs](https://example.com?a=1&b=2), [relative](./guide.md), and &amp; &lt; &gt;."
    );
  });
});
