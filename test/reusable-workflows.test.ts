import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Reusable org-level workflow templates (#37). These ship as copy-paste files for
 * an org's `.github` repo + per-repo callers, so they're validated here against
 * drift: valid YAML, the workflow_call contract, the trusted action pin (never the
 * dogfood `uses: ./`), and the security guards.
 */
const dir = join(process.cwd(), "examples", "reusable");
const read = (name: string): string => readFileSync(join(dir, name), "utf8");

// YAML 1.2 keeps `on` a string key; fall back to the YAML 1.1 boolean-true key.
function triggers(doc: Record<string, unknown>): Record<string, unknown> {
  return (doc.on ?? (doc as Record<string, unknown>)["true"] ?? (doc as Record<PropertyKey, unknown>)[true as unknown as string]) as Record<
    string,
    unknown
  >;
}

const REUSABLE = ["prowl-review.yml", "prowl-review-command.yml"] as const;
const CALLERS = ["caller-prowl-review.yml", "caller-prowl-review-command.yml"] as const;

describe("reusable org workflows (#37)", () => {
  it.each([...REUSABLE, ...CALLERS])("%s is valid YAML", (name) => {
    expect(() => parseYaml(read(name))).not.toThrow();
  });

  it.each(REUSABLE)("%s is a workflow_call (reusable) workflow with declared secrets", (name) => {
    const doc = parseYaml(read(name)) as Record<string, unknown>;
    const on = triggers(doc);
    expect(on).toHaveProperty("workflow_call");
    const call = on.workflow_call as { secrets?: Record<string, unknown>; inputs?: Record<string, unknown> };
    expect(call.secrets).toHaveProperty("PROWL_AI_KEY");
    expect(call.secrets).toHaveProperty("PROWL_AI_KEY_ANTHROPIC");
    expect(call.inputs).toHaveProperty("ai-provider");
    expect(call.inputs).toHaveProperty("runs-on");
  });

  it.each(REUSABLE)("%s pins the published action, never the dogfood local action", (name) => {
    const text = read(name);
    expect(text).toContain("uses: prowl-tools/prowl-code-review@v1");
    expect(text).not.toContain("uses: ./");
  });

  it.each(REUSABLE)("%s grants the token scopes the review needs", (name) => {
    const doc = parseYaml(read(name)) as { permissions?: Record<string, string> };
    expect(doc.permissions).toMatchObject({
      "pull-requests": "write",
      issues: "write",
      "checks": "write",
      contents: "read"
    });
  });

  it("the auto-review workflow loads config/guidelines from the trusted base, not PR code", () => {
    const doc = parseYaml(read("prowl-review.yml")) as Record<string, unknown>;
    const text = read("prowl-review.yml");
    // Fork + draft guard on the job.
    const review = (doc.jobs as { review: { if: string } }).review;
    expect(review.if).toContain("head.repo.full_name == github.repository");
    expect(review.if).toContain("draft == false");
    // Base checkout feeds guidelines; PR checkout feeds context.
    expect(text).toContain("ref: ${{ github.event.pull_request.base.sha }}");
    expect(text).toContain("guidelines-path: ${{ github.workspace }}/prowl-base");
  });

  it("the command workflow trust-gates the author and skips fork heads", () => {
    const text = read("prowl-review-command.yml");
    expect(text).toContain("github.event.comment.author_association == 'OWNER'");
    expect(text).toContain("github.event.comment.author_association == 'MEMBER'");
    expect(text).toContain("github.event.comment.author_association == 'COLLABORATOR'");
    expect(text).toContain("github.event.comment.user.type != 'Bot'");
    expect(text).toContain("mode: command");
    expect(text).toContain("steps.pr.outputs.trusted_head == 'true'");
  });

  it.each(CALLERS)("%s invokes the org workflow with inherited secrets in a few lines", (name) => {
    const doc = parseYaml(read(name)) as { jobs: Record<string, { uses?: string; secrets?: unknown }> };
    const job = Object.values(doc.jobs)[0];
    expect(job.uses).toMatch(/^Prowl-qa\/\.github\/\.github\/workflows\/.+@v1$/);
    expect(job.secrets).toBe("inherit");
  });

  it.each(CALLERS)("%s grants caller token scopes (a reusable workflow can only reduce them)", (name) => {
    const doc = parseYaml(read(name)) as { permissions?: Record<string, string> };
    expect(doc.permissions).toMatchObject({ "pull-requests": "write", issues: "write" });
  });
});
