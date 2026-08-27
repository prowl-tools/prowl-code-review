import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * Reusable org-level workflow templates (#37). These ship as copy-paste files for
 * an org's `.github` repo + per-repo callers, so they're validated here against
 * drift: valid YAML, the workflow_call contract, the trusted action pin (never the
 * dogfood `uses: ./`), and the security guards.
 */
const dir = join(process.cwd(), "examples", "reusable");
const read = (name: string): string => readFileSync(join(dir, name), "utf8");
const readRepo = (path: string): string => readFileSync(join(process.cwd(), path), "utf8");

// YAML 1.2 keeps `on` a string key; fall back to the YAML 1.1 boolean-true key.
function triggers(doc: Record<string, unknown>): Record<string, unknown> {
  return (doc.on ?? doc.true) as Record<string, unknown>;
}

const REUSABLE = ["prowl-review.yml", "prowl-review-command.yml"] as const;
const CALLERS = ["caller-prowl-review.yml", "caller-prowl-review-command.yml"] as const;
const ALL_WORKFLOWS = [...REUSABLE, ...CALLERS] as const;
const DOGFOOD_WORKFLOWS = [".github/workflows/prowl-review.yml", ".github/workflows/prowl-review-command.yml"] as const;
const CREATE_GITHUB_APP_TOKEN_PIN = "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1";
const CALLER_ORG_PLACEHOLDER = "YOUR-ORG";
const CALLER_ORG_REPLACEMENT_NOTICE = "TODO: replace YOUR-ORG with your GitHub organization before copying.";
const PRODUCTION_ORG_WORKFLOW_REF =
  /^(?!YOUR-ORG\/)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/\.github\/\.github\/workflows\/.+@v1$/;

const permissionSchema = z.record(z.string(), z.enum(["read", "write", "none"]));
const expressionOrLiteralSchema = z.union([z.string(), z.number(), z.boolean()]);
const workflowCallInputSchema = z
  .object({
    description: z.string().optional(),
    type: z.enum(["boolean", "number", "string"]),
    required: z.boolean().optional(),
    default: z.unknown().optional()
  })
  .strict();
const workflowCallSecretSchema = z
  .object({
    description: z.string().optional(),
    required: z.boolean().optional()
  })
  .strict();
const workflowCallSchema = z
  .object({
    inputs: z.record(z.string(), workflowCallInputSchema).optional(),
    secrets: z.record(z.string(), workflowCallSecretSchema).optional(),
    outputs: z.record(z.string(), z.unknown()).optional()
  })
  .strict();
const eventTriggerSchema = z.union([
  z.null(),
  z.array(z.string()),
  z
    .object({
      types: z.array(z.string()).optional()
    })
    .passthrough()
]);
const onSchema = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  for (const [name, config] of Object.entries(value)) {
    const schema = name === "workflow_call" ? workflowCallSchema : eventTriggerSchema;
    const result = schema.safeParse(config);
    if (!result.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [name],
        message: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
      });
    }
  }
});
const stepSchema = z
  .object({
    name: z.string().optional(),
    id: z.string().optional(),
    if: z.string().optional(),
    uses: z.string().optional(),
    run: z.string().optional(),
    shell: z.string().optional(),
    env: z.record(z.string(), z.unknown()).optional(),
    with: z.record(z.string(), z.unknown()).optional(),
    "working-directory": z.string().optional(),
    "continue-on-error": expressionOrLiteralSchema.optional(),
    "timeout-minutes": expressionOrLiteralSchema.optional()
  })
  .strict()
  .refine((step) => (step.uses !== undefined) !== (step.run !== undefined), "step must define exactly one of uses or run");
const concurrencySchema = z
  .object({
    group: z.string(),
    "cancel-in-progress": expressionOrLiteralSchema.optional()
  })
  .strict();
const reusableJobSchema = z
  .object({
    name: z.string().optional(),
    if: z.string().optional(),
    needs: z.union([z.string(), z.array(z.string())]).optional(),
    permissions: permissionSchema.optional(),
    "runs-on": z.union([z.string(), z.array(z.string())]),
    concurrency: concurrencySchema.optional(),
    steps: z.array(stepSchema),
    env: z.record(z.string(), z.unknown()).optional(),
    defaults: z.record(z.string(), z.unknown()).optional(),
    outputs: z.record(z.string(), z.unknown()).optional(),
    strategy: z.record(z.string(), z.unknown()).optional(),
    "timeout-minutes": expressionOrLiteralSchema.optional()
  })
  .strict();
const callerJobSchema = z
  .object({
    name: z.string().optional(),
    if: z.string().optional(),
    needs: z.union([z.string(), z.array(z.string())]).optional(),
    permissions: permissionSchema.optional(),
    uses: z.string(),
    with: z.record(z.string(), z.unknown()).optional(),
    secrets: z.union([z.literal("inherit"), z.record(z.string(), z.unknown())]).optional()
  })
  .strict();
const workflowSchema = z
  .object({
    name: z.string(),
    on: onSchema.optional(),
    true: onSchema.optional(),
    permissions: permissionSchema.optional(),
    jobs: z.record(z.string(), z.union([reusableJobSchema, callerJobSchema]))
  })
  .strict()
  .refine((workflow) => workflow.on !== undefined || workflow.true !== undefined, "workflow must declare triggers");

function parseWorkflow(name: (typeof ALL_WORKFLOWS)[number]): Record<string, unknown> {
  return parseYaml(read(name)) as Record<string, unknown>;
}

function outputMap(path: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
  );
}

function expectValidWorkflowSchema(name: string, doc: unknown): void {
  const result = workflowSchema.safeParse(doc);
  expect(
    result.success,
    result.success ? undefined : `${name} failed the local GitHub Actions schema check:\n${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n")}`
  ).toBe(true);
}

function stepsFor(doc: Record<string, unknown>, jobName: string): Array<Record<string, unknown>> {
  const jobs = doc.jobs as Record<string, { steps: Array<Record<string, unknown>> }>;
  return jobs[jobName].steps;
}

function normalizeExpression(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function shouldRunAutoReview(input: { headRepo: string; repository: string; approvedActor: boolean }): boolean {
  return input.headRepo === input.repository && input.approvedActor;
}

function shouldRunCommandJob(input: { isPullRequest: boolean; userType: string; authorAssociation: string; body: string }): boolean {
  return (
    input.isPullRequest &&
    input.userType !== "Bot" &&
    ["OWNER", "MEMBER", "COLLABORATOR"].includes(input.authorAssociation) &&
    input.body.includes("@prowl-review") &&
    !input.body.includes("<!-- prowl-review:summary -->") &&
    !input.body.includes("<!-- prowl-review:finding ")
  );
}

function shouldRunCommandAction(trustedHead: string): boolean {
  return trustedHead === "true";
}

function hasCompletePrMetadata(input: { baseSha: string; headSha: string; headRepo: string }): boolean {
  return Object.values(input).every((value) => value !== "" && value !== "null");
}

describe("reusable org workflows (#37)", () => {
  it.each(ALL_WORKFLOWS)("%s is valid GitHub Actions workflow YAML", (name) => {
    expect(() => parseWorkflow(name)).not.toThrow();
    expectValidWorkflowSchema(name, parseWorkflow(name));
  });

  it("the schema check rejects unsupported workflow structure", () => {
    const doc = parseWorkflow("prowl-review.yml");
    const review = (doc.jobs as { review: { concurrency: Record<string, unknown> } }).review;
    review.concurrency.unsupported = "value";
    expect(workflowSchema.safeParse(doc).success).toBe(false);
  });

  it("the schema check requires exactly one of uses or run per step", () => {
    const missingAction = parseWorkflow("prowl-review.yml");
    stepsFor(missingAction, "review")[0] = { name: "Invalid empty step" };
    expect(workflowSchema.safeParse(missingAction).success).toBe(false);

    const conflictingAction = parseWorkflow("prowl-review.yml");
    stepsFor(conflictingAction, "review")[0] = {
      name: "Invalid mixed step",
      uses: "actions/checkout@v4",
      run: "echo invalid"
    };
    expect(workflowSchema.safeParse(conflictingAction).success).toBe(false);
  });

  it.each(REUSABLE)("%s is a workflow_call (reusable) workflow with declared secrets", (name) => {
    const doc = parseWorkflow(name);
    const on = triggers(doc);
    expect(on).toHaveProperty("workflow_call");
    const call = on.workflow_call as { secrets?: Record<string, unknown>; inputs?: Record<string, unknown> };
    expect(call.secrets).toHaveProperty("PROWL_AI_KEY");
    expect(call.secrets).toHaveProperty("PROWL_AI_KEY_ANTHROPIC");
    expect(call.inputs).toHaveProperty("ai-provider");
    expect(call.inputs).toHaveProperty("min-severity");
    expect(call.inputs).toHaveProperty("config-path");
    expect(call.inputs).toHaveProperty("org-guidelines-path");
    expect(call.inputs).toHaveProperty("org-guidelines-workspace");
    expect(call.inputs).toHaveProperty("runs-on");
    if (name === "prowl-review.yml") {
      expect(call.inputs).toHaveProperty("allowed-actors");
    }
  });

  it.each(REUSABLE)("%s pins the published action, never the dogfood local action", (name) => {
    const text = read(name);
    expect(text).toContain("uses: prowl-tools/prowl-code-review@v1");
    expect(text).not.toContain("uses: ./");
  });

  it.each(DOGFOOD_WORKFLOWS)("%s dogfoods the local action, never the published v1 action", (path) => {
    const text = readRepo(path);
    expect(text).toMatch(/^\s*uses:\s*\.\/prowl-base(?:\s+#.*)?$/m);
    expect(text).not.toMatch(/^\s*uses:\s*prowl-tools\/prowl-code-review@v1\b/m);
  });

  it.each(DOGFOOD_WORKFLOWS)("%s loads trusted config and guidelines from prowl-base", (path) => {
    const doc = parseYaml(readRepo(path)) as Record<string, unknown>;
    const jobName = path.endsWith("prowl-review.yml") ? "review" : "command";
    const steps = stepsFor(doc, jobName);
    const checkoutBase = steps.find((step) => step.name === "Checkout trusted base (config + guidelines)") as {
      with: Record<string, unknown>;
    };
    const reviewStepName = jobName === "review" ? "prowl-review" : "prowl-review command";
    const reviewStep = steps.find((step) => step.name === reviewStepName) as {
      uses: string;
      with: Record<string, unknown>;
    };
    expect(checkoutBase.with).toMatchObject({ path: "prowl-base" });
    expect(reviewStep.uses).toBe("./prowl-base");
    expect(reviewStep.with).toMatchObject({
      "config-path": "${{ github.workspace }}/prowl-base/.prowl-review.yml",
      "guidelines-path": "${{ github.workspace }}/prowl-base",
      "workspace-path": "${{ github.workspace }}/pr-head"
    });
  });

  it.each(REUSABLE)("%s grants the token scopes the review needs", (name) => {
    const doc = parseWorkflow(name) as { permissions?: Record<string, string> };
    expect(doc.permissions).toMatchObject({
      "pull-requests": "write",
      issues: "write",
      "checks": "write",
      contents: "read"
    });
  });

  it("the auto-review workflow loads config/guidelines from the trusted base, not PR code", () => {
    const doc = parseWorkflow("prowl-review.yml");
    const text = read("prowl-review.yml");
    // Chained off CI via workflow_run (#61): gate on the triggering event type +
    // the CI conclusion in the resolver, then review only after PR resolution.
    const jobs = doc.jobs as { resolve: { if: string }; review: { if: string } };
    expect(normalizeExpression(jobs.resolve.if)).toBe(
      "github.event.workflow_run.event == 'pull_request' && github.event.workflow_run.conclusion == 'success'"
    );
    expect(normalizeExpression(jobs.review.if)).toBe(
      "needs.resolve.outputs.resolved == 'true' && needs.resolve.outputs.approved_actor == 'true'"
    );
    // Base checkout feeds guidelines from the RESOLVED PR; PR checkout feeds context.
    expect(text).toContain("ref: ${{ needs.resolve.outputs.base_sha }}");
    expect(text).toContain("ref: ${{ needs.resolve.outputs.head_sha }}");
    expect(text).toContain("guidelines-path: ${{ github.workspace }}/prowl-base");
    // The trusted base SHA is never taken from the PR-controlled event payload.
    expect(text).not.toContain("github.event.pull_request.base.sha");
  });

  it.each([
    ["same-repo ready PR by approved actor", { headRepo: "Prowl-qa/app", repository: "Prowl-qa/app", approvedActor: true }, true],
    ["same-repo draft PR by approved actor", { headRepo: "Prowl-qa/app", repository: "Prowl-qa/app", approvedActor: true }, true],
    ["same-repo PR by unapproved actor", { headRepo: "Prowl-qa/app", repository: "Prowl-qa/app", approvedActor: false }, false],
    ["fork PR by approved actor", { headRepo: "contributor/app", repository: "Prowl-qa/app", approvedActor: true }, false]
  ])("the auto-review job guard handles %s", (_name, input, expected) => {
    expect(shouldRunAutoReview(input)).toBe(expected);
  });

  it("the command workflow trust-gates the author and skips fork heads", () => {
    const doc = parseWorkflow("prowl-review-command.yml");
    const command = (doc.jobs as { command: { if: string } }).command;
    const commandStep = stepsFor(doc, "command").find((step) => step.name === "prowl-review command") as { if: string };
    expect(command.if).toContain("github.event.comment.author_association == 'OWNER'");
    expect(command.if).toContain("github.event.comment.author_association == 'MEMBER'");
    expect(command.if).toContain("github.event.comment.author_association == 'COLLABORATOR'");
    expect(command.if).toContain("github.event.comment.user.type != 'Bot'");
    expect(command.if).toContain("contains(github.event.comment.body, '@prowl-review')");
    expect(commandStep.if).toBe("steps.pr.outputs.trusted_head == 'true'");
  });

  it.each([
    ["trusted maintainer command", { isPullRequest: true, userType: "User", authorAssociation: "MEMBER", body: "@prowl-review review" }, true],
    ["plain issue comment", { isPullRequest: false, userType: "User", authorAssociation: "MEMBER", body: "@prowl-review review" }, false],
    ["bot comment", { isPullRequest: true, userType: "Bot", authorAssociation: "MEMBER", body: "@prowl-review review" }, false],
    ["untrusted author", { isPullRequest: true, userType: "User", authorAssociation: "CONTRIBUTOR", body: "@prowl-review review" }, false],
    ["missing mention", { isPullRequest: true, userType: "User", authorAssociation: "OWNER", body: "please review" }, false],
    ["summary marker", { isPullRequest: true, userType: "User", authorAssociation: "OWNER", body: "@prowl-review <!-- prowl-review:summary -->" }, false],
    ["finding marker", { isPullRequest: true, userType: "User", authorAssociation: "OWNER", body: "@prowl-review <!-- prowl-review:finding abc -->" }, false]
  ])("the command job guard handles %s", (_name, input, expected) => {
    expect(shouldRunCommandJob(input)).toBe(expected);
  });

  it.each([
    ["same-repo PR head", "true", true],
    ["fork PR head", "false", false]
  ])("the command action guard handles %s", (_name, trustedHead, expected) => {
    expect(shouldRunCommandAction(trustedHead)).toBe(expected);
  });

  it("the command workflow mirrors the trusted-base action inputs", () => {
    const doc = parseWorkflow("prowl-review-command.yml");
    const steps = stepsFor(doc, "command");
    const resolvePr = steps.find((step) => step.name === "Resolve PR metadata") as { run: string };
    const checkoutBase = steps.find((step) => step.name === "Checkout trusted base (config + guidelines)") as {
      with: Record<string, unknown>;
    };
    const commandStep = steps.find((step) => step.name === "prowl-review command") as { with: Record<string, unknown> };
    expect(resolvePr.run).toContain('.base.sha // ""');
    expect(resolvePr.run).toContain('[ "${base_sha}" = "null" ]');
    expect(checkoutBase.with).toMatchObject({ path: "prowl-base" });
    expect(commandStep.with).toMatchObject({
      mode: "command",
      "min-severity": "${{ inputs.min-severity }}",
      "config-path": "${{ inputs.config-path }}",
      "guidelines-path": "${{ github.workspace }}/prowl-base",
      "org-guidelines-path": "${{ inputs.org-guidelines-path }}",
      "org-guidelines-workspace": "${{ inputs.org-guidelines-workspace }}",
      "workspace-path": "${{ github.workspace }}/pr-head"
    });
  });

  it.each([
    ["complete metadata", { baseSha: "abc", headSha: "def", headRepo: "Prowl-qa/app" }, true],
    ["missing base SHA", { baseSha: "", headSha: "def", headRepo: "Prowl-qa/app" }, false],
    ["null base SHA", { baseSha: "null", headSha: "def", headRepo: "Prowl-qa/app" }, false],
    ["missing head SHA", { baseSha: "abc", headSha: "", headRepo: "Prowl-qa/app" }, false],
    ["null head SHA", { baseSha: "abc", headSha: "null", headRepo: "Prowl-qa/app" }, false],
    ["missing head repository", { baseSha: "abc", headSha: "def", headRepo: "" }, false],
    ["null head repository", { baseSha: "abc", headSha: "def", headRepo: "null" }, false]
  ])("the command metadata guard handles %s", (_name, input, expected) => {
    expect(hasCompletePrMetadata(input)).toBe(expected);
  });

  it.each(CALLERS)("%s keeps the org workflow placeholder explicit and substitutes to a valid ref", (name) => {
    const doc = parseWorkflow(name) as { jobs: Record<string, { uses?: string; secrets?: unknown }> };
    const job = Object.values(doc.jobs)[0];
    const uses = job.uses;
    expect(typeof uses).toBe("string");
    if (typeof uses !== "string") {
      throw new Error(`${name} must define a reusable workflow reference`);
    }
    expect(uses.startsWith(CALLER_ORG_PLACEHOLDER + "/.github/.github/workflows/")).toBe(true);
    expect(uses.endsWith("@v1")).toBe(true);
    expect(uses).not.toMatch(PRODUCTION_ORG_WORKFLOW_REF);
    expect(uses.replace(CALLER_ORG_PLACEHOLDER + "/", "acme-corp/")).toMatch(PRODUCTION_ORG_WORKFLOW_REF);
    expect(job.secrets).toBe("inherit");
  });

  it.each(CALLERS)("%s marks YOUR-ORG as a required in-file replacement", (name) => {
    const text = read(name);
    expect(text).toContain(
      "# " + CALLER_ORG_REPLACEMENT_NOTICE + "\n    uses: " + CALLER_ORG_PLACEHOLDER + "/.github/.github/workflows/"
    );
  });

  it("the reusable README marks YOUR-ORG as a required replacement before copy-paste snippets", () => {
    const text = read("README.md");
    expect(text).toContain("Replace `YOUR-ORG` with the organization that");
    expect(text).toContain(
      "# " +
        CALLER_ORG_REPLACEMENT_NOTICE +
        "\n    uses: " +
        CALLER_ORG_PLACEHOLDER +
        "/.github/.github/workflows/prowl-review.yml@v1"
    );
  });

  it("the reusable auto-review caller enables the branded replacement check by default", () => {
    const caller = parseWorkflow("caller-prowl-review.yml") as {
      jobs: { review: { with?: Record<string, unknown> } };
    };
    const reusable = parseWorkflow("prowl-review.yml") as Record<string, unknown>;
    const on = triggers(reusable);
    const call = on.workflow_call as { inputs?: Record<string, { default?: unknown }> };
    const reviewStep = stepsFor(reusable, "review").find((step) => step.name === "prowl-review") as {
      with: Record<string, unknown>;
    };

    expect(caller.jobs.review.with).toMatchObject({ "check-run": true });
    expect(call.inputs?.["check-run"]?.default).toBe(true);
    expect(reviewStep.with["check-run"]).toBe("${{ inputs.check-run }}");
  });

  it.each(CALLERS)("%s grants caller token scopes (a reusable workflow can only reduce them)", (name) => {
    const doc = parseWorkflow(name) as { permissions?: Record<string, string> };
    expect(doc.permissions).toMatchObject({ "pull-requests": "write", issues: "write" });
  });

  it.each(REUSABLE)("%s supports the optional branded App-token identity (#59)", (name) => {
    const doc = parseWorkflow(name) as Record<string, unknown>;
    const on = triggers(doc);
    const call = on.workflow_call as { secrets?: Record<string, unknown> };
    // Optional branded-identity secrets are declared.
    expect(call.secrets).toHaveProperty("PROWL_APP_ID");
    expect(call.secrets).toHaveProperty("PROWL_APP_PRIVATE_KEY");
    const text = read(name);
    // Mints an App token and falls back to the default token when unset.
    expect(text).toContain("uses: actions/create-github-app-token@v1");
    expect(text).toContain("steps.app-token.outputs.token || github.token");
    expect(text).toContain(
      "bot-login: ${{ steps.app-token.outputs.app-slug != '' && format('{0}[bot]', steps.app-token.outputs.app-slug) || '' }}"
    );
    const jobName = name === "prowl-review.yml" ? "review" : "command";
    const steps = stepsFor(doc, jobName);
    const brand = steps.find((step) => step.id === "brand") as { env: Record<string, unknown>; run: string };
    const appToken = steps.find((step) => step.id === "app-token") as { with: Record<string, unknown> };
    expect(brand.env).toHaveProperty("APP_ID");
    expect(brand.env).toHaveProperty("APP_PRIVATE_KEY");
    expect(String(brand.env.APP_ID)).toContain("PROWL_APP_ID");
    expect(String(brand.env.APP_PRIVATE_KEY)).toContain("PROWL_APP_PRIVATE_KEY");
    expect(brand.run).toContain('[ -n "${APP_ID}" ] && [ -n "${APP_PRIVATE_KEY}" ]');
    expect(appToken.with).toMatchObject({
      "permission-contents": "read",
      "permission-issues": "write",
      "permission-pull-requests": "write",
      "permission-checks": "write"
    });
  });

  it("the branded standalone example wires the App token into github-token/bot-login (#59)", () => {
    const text = readRepo("examples/workflows/prowl-review-branded.yml");
    const doc = parseYaml(text) as {
      permissions?: Record<string, string>;
      concurrency?: Record<string, unknown>;
      jobs: { review: { if?: string; steps: Array<Record<string, unknown>> } };
    };
    const appToken = doc.jobs.review.steps.find((step) => step.id === "app-token") as { with: Record<string, unknown> };
    expect(() => parseYaml(text)).not.toThrow();
    expect(doc.permissions).toEqual({ contents: "read" });
    expect(doc.concurrency).toMatchObject({
      group: "prowl-review-${{ github.event.pull_request.number }}",
      "cancel-in-progress": false
    });
    expect(normalizeExpression(doc.jobs.review.if ?? "")).toBe(
      "github.event.pull_request.head.repo.full_name == github.repository"
    );
    expect(appToken.with).toMatchObject({
      "permission-contents": "read",
      "permission-issues": "write",
      "permission-pull-requests": "write",
      "permission-checks": "write"
    });
    expect(text).toContain("uses: actions/create-github-app-token@v1");
    expect(text).toContain("github-token: ${{ steps.app-token.outputs.token }}");
    expect(text).toContain("bot-login: ${{ steps.app-token.outputs.app-slug }}[bot]");
  });

  it.each(DOGFOOD_WORKFLOWS)("%s dogfoods the optional branded App-token identity (#59)", (path) => {
    const text = readRepo(path);
    const doc = parseYaml(text) as Record<string, unknown>;
    // Mints an App token when PROWL_APP_ID is set; falls back to the default token otherwise.
    expect(text).toContain(`uses: ${CREATE_GITHUB_APP_TOKEN_PIN}`);
    expect(text).not.toContain("uses: actions/create-github-app-token@v1");
    expect(text).toContain("github-token: ${{ steps.app-token.outputs.token || github.token }}");
    expect(text).toContain(
      "bot-login: ${{ steps.app-token.outputs.app-slug != '' && format('{0}[bot]', steps.app-token.outputs.app-slug) || '' }}"
    );
    const jobName = path.endsWith("prowl-review.yml") ? "review" : "command";
    const job = (doc.jobs as Record<string, { env?: Record<string, unknown>; steps: Array<Record<string, unknown>> }>)[jobName];
    const steps = job.steps;
    const appToken = steps.find((step) => step.id === "app-token") as { if?: string; with: Record<string, unknown> };
    expect(job.env).toMatchObject({
      PROWL_APP_CONFIGURED: "${{ secrets.PROWL_APP_ID != '' && secrets.PROWL_APP_PRIVATE_KEY != '' }}"
    });
    expect(steps.some((step) => step.id === "brand")).toBe(false);
    // Token minting is gated so the workflow still runs (unbranded) before the App exists.
    expect(appToken.if).toBe("env.PROWL_APP_CONFIGURED == 'true'");
    expect(appToken.with).toMatchObject({
      "permission-contents": "read",
      "permission-issues": "write",
      "permission-pull-requests": "write",
      "permission-checks": "write"
    });
  });
});

// Single branded checks row via workflow_run chaining (#61). The auto-review is
// triggered by CI COMPLETING, not by pull_request, so it attaches no octocat row
// to the PR checks list — the branded "Prowl Review" check run is the only
// prowl-review presence. These guard the trigger shape, the conclusion/event
// gating, and the single-PR resolution across the dogfood + reusable templates.
describe("single branded checks row (#61)", () => {
  const AUTO_REVIEW_TEMPLATES = [
    { label: "dogfood", read: () => readRepo(".github/workflows/prowl-review.yml") },
    { label: "reusable", read: () => read("prowl-review.yml") }
  ] as const;
  const TRIGGERED_ON_CI = [
    { label: "dogfood", read: () => readRepo(".github/workflows/prowl-review.yml") },
    { label: "caller", read: () => read("caller-prowl-review.yml") }
  ] as const;

  it("CI subscribes to the PR transitions workflow_run cannot preserve", () => {
    const ci = parseYaml(readRepo(".github/workflows/ci.yml")) as Record<string, unknown>;
    const on = triggers(ci);
    const pullRequest = on.pull_request as { types?: string[] };
    // workflow_run drops the original PR action, so CI itself must fire on each one.
    expect(pullRequest.types).toEqual(expect.arrayContaining(["opened", "synchronize", "ready_for_review", "reopened"]));
  });

  it.each(TRIGGERED_ON_CI)("$label auto-review triggers off the CI workflow completing, not pull_request", ({ read: readFn }) => {
    const doc = parseYaml(readFn()) as Record<string, unknown>;
    const on = triggers(doc);
    expect(on).toHaveProperty("workflow_run");
    expect(on).not.toHaveProperty("pull_request");
    const workflowRun = on.workflow_run as { workflows?: string[]; types?: string[] };
    expect(workflowRun.workflows).toContain("CI");
    expect(workflowRun.types).toContain("completed");
  });

  it.each(AUTO_REVIEW_TEMPLATES)("$label auto-review job gates on the workflow_run event type and CI conclusion", ({ label, read: readFn }) => {
    const doc = parseYaml(readFn()) as { jobs: { resolve: { if: string }; review: { if: string; needs: string } } };
    // Skip push-triggered CI completions; start only on a green pull_request CI run.
    expect(normalizeExpression(doc.jobs.resolve.if)).toBe(
      "github.event.workflow_run.event == 'pull_request' && github.event.workflow_run.conclusion == 'success'"
    );
    expect(doc.jobs.review.needs).toBe("resolve");
    if (label === "dogfood") {
      // Self-hosted Codex dogfood (#64): an explicit job-level trust gate keeps
      // fork PRs and unapproved same-repo authors off the self-hosted runner.
      expect(normalizeExpression(doc.jobs.review.if)).toBe(
        "needs.resolve.outputs.resolved == 'true' && needs.resolve.outputs.head_repo == github.repository && needs.resolve.outputs.approved_actor == 'true'"
      );
    } else {
      expect(normalizeExpression(doc.jobs.review.if)).toBe(
        "needs.resolve.outputs.resolved == 'true' && needs.resolve.outputs.approved_actor == 'true'"
      );
    }
  });

  it.each(AUTO_REVIEW_TEMPLATES)("$label auto-review resolves exactly one open PR before reviewing", ({ label, read: readFn }) => {
    const text = readFn();
    const doc = parseYaml(text) as {
      jobs: {
        resolve: { outputs: Record<string, unknown>; steps: Array<Record<string, unknown>> };
        "report-unreviewable": { if: string; needs: string; steps: Array<Record<string, unknown>> };
        review: { if: string; steps: Array<Record<string, unknown>> };
      };
    };
    const steps = doc.jobs.resolve.steps;
    const resolve = steps.find((step) => step.id === "pr") as { env: Record<string, unknown>; run: string } | undefined;
    expect(resolve).toBeDefined();
    expect(resolve!.env.CHECK_RUN).toBe(label === "dogfood" ? "true" : "${{ inputs.check-run }}");
    expect(doc.jobs.resolve.outputs).toMatchObject({
      resolved: "${{ steps.pr.outputs.resolved }}",
      pr_number: "${{ steps.pr.outputs.pr_number }}",
      base_sha: "${{ steps.pr.outputs.base_sha }}",
      head_sha: "${{ steps.pr.outputs.head_sha }}",
      head_repo: "${{ steps.pr.outputs.head_repo }}",
      approved_actor: "${{ steps.pr.outputs.approved_actor }}",
      is_draft: "${{ steps.pr.outputs.is_draft }}",
      check_head_sha: "${{ steps.pr.outputs.check_head_sha }}",
      check_conclusion: "${{ steps.pr.outputs.check_conclusion }}",
      check_title: "${{ steps.pr.outputs.check_title }}",
      check_summary: "${{ steps.pr.outputs.check_summary }}"
    });
    // Merge the payload's pull_requests with a completed-run API lookup.
    expect(resolve!.run).toContain("jq -r '.[]?.number // empty'");
    expect(resolve!.run).toContain("payload_candidates=");
    expect(resolve!.run).toContain("api_candidates=");
    expect(resolve!.run).toContain('candidates="${payload_candidates}${payload_candidates:+ }${api_candidates}"');
    expect(resolve!.run).toContain('gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${RUN_ID}"');
    // Require EXACTLY ONE match; a missing/ambiguous match skips (resolved=false).
    expect(resolve!.run).toContain('[ "${count}" -ne 1 ]');
    expect(resolve!.run).toContain("resolved=false");
    expect(resolve!.run).toContain("resolved=true");
    // Re-derive trusted base/head and reject if the live head moved after CI.
    expect(resolve!.run).toContain("[.base.sha, .head.sha, .head.repo.full_name, .draft, .user.login, .author_association] | @tsv");
    expect(resolve!.run).toContain('[ "${head_sha}" != "${HEAD_SHA}" ]');
    expect(resolve!.run).toContain("head moved from CI head");
    // Forks are rejected before secrets; drafts are passed to the action's config-aware policy.
    expect(resolve!.run).toContain('[ "${head_repo}" != "${GITHUB_REPOSITORY}" ]');
    expect(resolve!.run).not.toContain('gh api "repos/${GITHUB_REPOSITORY}/check-runs"');
    expect(resolve!.run).toContain('report_check "neutral" "Fork pull request - review skipped"');
    expect(resolve!.run).toContain("Fork pull request - review skipped");
    expect(resolve!.run).toContain("is_approved_actor");
    expect(resolve!.run).toContain("Review skipped - unauthorized actor");
    expect(resolve!.run).toContain("is_draft=${is_draft}");
    expect(resolve!.run).not.toContain('[ "${is_draft}" = "true" ]');

    const reportJob = doc.jobs["report-unreviewable"];
    expect(reportJob.needs).toBe("resolve");
    expect(reportJob.if).toBe("needs.resolve.outputs.check_conclusion != ''");
    const reportSteps = reportJob.steps;
    const reportAppTokenIndex = reportSteps.findIndex((step) => step.id === "app-token");
    const reportPublishIndex = reportSteps.findIndex((step) => step.name === "Publish Prowl Review setup result");
    expect(reportAppTokenIndex).toBeGreaterThanOrEqual(0);
    expect(reportPublishIndex).toBeGreaterThan(reportAppTokenIndex);
    expect(reportSteps[reportAppTokenIndex]["continue-on-error"]).toBe(true);
    const publishReport = reportSteps[reportPublishIndex] as { env: Record<string, unknown>; run: string };
    expect(publishReport.env.GH_TOKEN).toBe("${{ steps.app-token.outputs.token || github.token }}");
    expect(publishReport.env.HEAD_SHA).toBe("${{ needs.resolve.outputs.check_head_sha }}");
    expect(publishReport.env.CHECK_CONCLUSION).toBe("${{ needs.resolve.outputs.check_conclusion }}");
    expect(publishReport.run).toContain('gh api "repos/${GITHUB_REPOSITORY}/check-runs"');
    expect(publishReport.run).toContain("status=completed");
    expect(publishReport.run).toContain("conclusion=${CHECK_CONCLUSION}");

    // The action only runs once a single PR resolved, and gets its number handed in.
    const reviewSteps = doc.jobs.review.steps;
    const openCheckIndex = reviewSteps.findIndex((step) => step.id === "open-check");
    const appTokenIndex = reviewSteps.findIndex((step) => step.id === "app-token");
    const firstCheckoutIndex = reviewSteps.findIndex((step) => String(step.name ?? "").startsWith("Checkout"));
    expect(appTokenIndex).toBeGreaterThanOrEqual(0);
    expect(openCheckIndex).toBeGreaterThan(appTokenIndex);
    expect(openCheckIndex).toBeLessThan(firstCheckoutIndex);
    expect(reviewSteps[appTokenIndex]["continue-on-error"]).toBe(true);
    const openCheck = reviewSteps[openCheckIndex] as { env: Record<string, unknown>; run: string };
    expect(openCheck.env.GH_TOKEN).toBe("${{ steps.app-token.outputs.token || github.token }}");
    expect(openCheck.env.HEAD_SHA).toBe("${{ needs.resolve.outputs.head_sha }}");
    if (label === "reusable") {
      expect(openCheck.env.CHECK_RUN).toBe("${{ inputs.check-run }}");
      expect(openCheck.run).toContain('[ "${CHECK_RUN}" != "true" ]');
    } else {
      expect(openCheck.env.CHECK_RUN).toBeUndefined();
    }
    expect(openCheck.run).toContain('gh api "repos/${GITHUB_REPOSITORY}/check-runs"');
    expect(openCheck.run).toContain("status=in_progress");
    expect(openCheck.run).toContain("check_run_id=");

    const closeCheck = reviewSteps.find((step) => step.id === undefined && step.name === "Complete unfinished Prowl Review check") as {
      if: string;
      env: Record<string, unknown>;
      run: string;
    };
    expect(closeCheck.if).toContain("always()");
    expect(closeCheck.if).toContain("steps.open-check.outputs.check_run_id");
    expect(closeCheck.env.GH_TOKEN).toBe("${{ steps.app-token.outputs.token || github.token }}");
    expect(closeCheck.env.CHECK_RUN_ID).toBe("${{ steps.open-check.outputs.check_run_id }}");
    expect(closeCheck.run).toContain('gh api "repos/${GITHUB_REPOSITORY}/check-runs/${CHECK_RUN_ID}" --jq');
    expect(closeCheck.run).toContain('[ "${status}" = "completed" ]');
    expect(closeCheck.run).toContain("--method PATCH");
    expect(closeCheck.run).toContain("Review workflow failed");

    const reviewStep = reviewSteps.find((step) => (step.name as string | undefined)?.startsWith("prowl-review")) as {
      env: Record<string, unknown>;
      with: Record<string, unknown>;
    };
    if (label === "dogfood") {
      expect(normalizeExpression(doc.jobs.review.if)).toBe(
        "needs.resolve.outputs.resolved == 'true' && needs.resolve.outputs.head_repo == github.repository && needs.resolve.outputs.approved_actor == 'true'"
      );
    } else {
      expect(normalizeExpression(doc.jobs.review.if)).toBe(
        "needs.resolve.outputs.resolved == 'true' && needs.resolve.outputs.approved_actor == 'true'"
      );
    }
    expect(reviewStep.env.PROWL_REVIEWED_HEAD_SHA).toBe("${{ needs.resolve.outputs.head_sha }}");
    expect(reviewStep.env.PROWL_CHECK_RUN_ID).toBe("${{ steps.open-check.outputs.check_run_id }}");
    expect(reviewStep.with["pr-number"]).toBe("${{ needs.resolve.outputs.pr_number }}");
    expect(reviewStep.with["pr-draft"]).toBe("${{ needs.resolve.outputs.is_draft }}");
  });

  it.each(AUTO_REVIEW_TEMPLATES)(
    "$label auto-review uses API candidates when the workflow_run payload is non-empty but incomplete",
    ({ read: readFn }) => {
      const doc = parseYaml(readFn()) as {
        jobs: { resolve: { steps: Array<Record<string, unknown>> } };
      };
      const resolve = doc.jobs.resolve.steps.find((step) => step.id === "pr") as { run: string } | undefined;
      expect(resolve).toBeDefined();

      const temp = mkdtempSync(join(tmpdir(), "prowl-review-resolve-"));
      try {
        const bin = join(temp, "bin");
        const output = join(temp, "github-output");
        const log = join(temp, "gh.log");
        mkdirSync(bin);
        writeFileSync(
          join(bin, "jq"),
          `#!/usr/bin/env bash
set -euo pipefail
cat >/dev/null
printf '1\\n'
`
        );
        writeFileSync(
          join(bin, "gh"),
          `#!/usr/bin/env bash
set -euo pipefail
url="$2"
printf '%s\\n' "$url" >> "$GH_LOG"
case "$url" in
  repos/Prowl-qa/app/actions/runs/123)
    printf '2\\n'
    ;;
  repos/Prowl-qa/app/pulls/1)
    printf 'open\\tpayload-head\\n'
    ;;
  repos/Prowl-qa/app/pulls/2)
    if [[ "$*" == *'.base.sha'* ]]; then
      printf 'base-sha\\tci-head\\tProwl-qa/app\\tfalse\\toctocat\\tMEMBER\\n'
    else
      printf 'open\\tci-head\\n'
    fi
    ;;
  *)
    echo "unexpected gh call: $*" >&2
    exit 1
    ;;
esac
`
        );
        chmodSync(join(bin, "jq"), 0o755);
        chmodSync(join(bin, "gh"), 0o755);

        execFileSync("bash", ["-c", resolve!.run], {
          cwd: temp,
          env: {
            ...process.env,
            PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
            GH_LOG: log,
            GITHUB_OUTPUT: output,
            GITHUB_REPOSITORY: "Prowl-qa/app",
            PR_PAYLOAD: JSON.stringify([{ number: 1 }]),
            RUN_ID: "123",
            HEAD_SHA: "ci-head",
            REQUIRE_APPROVED_ACTOR: "true",
            APPROVED_ACTORS: "octocat"
          },
          stdio: "pipe"
        });

        expect(outputMap(output)).toMatchObject({
          resolved: "true",
          pr_number: "2",
          base_sha: "base-sha",
          head_sha: "ci-head",
          head_repo: "Prowl-qa/app",
          approved_actor: "true",
          is_draft: "false"
        });
        expect(readFileSync(log, "utf8")).toContain("repos/Prowl-qa/app/actions/runs/123");
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    }
  );

  it.each(AUTO_REVIEW_TEMPLATES)(
    "$label auto-review records a neutral replacement check before skipping fork PRs",
    ({ read: readFn }) => {
      const doc = parseYaml(readFn()) as {
        jobs: { resolve: { steps: Array<Record<string, unknown>> } };
      };
      const resolve = doc.jobs.resolve.steps.find((step) => step.id === "pr") as { run: string } | undefined;
      expect(resolve).toBeDefined();

      const temp = mkdtempSync(join(tmpdir(), "prowl-review-fork-skip-"));
      try {
        const bin = join(temp, "bin");
        const output = join(temp, "github-output");
        mkdirSync(bin);
        writeFileSync(
          join(bin, "jq"),
          `#!/usr/bin/env bash
set -euo pipefail
cat >/dev/null
printf '7\\n'
`
        );
        writeFileSync(
          join(bin, "gh"),
          `#!/usr/bin/env bash
set -euo pipefail
url="$2"
case "$url" in
  repos/Prowl-qa/app/actions/runs/123)
    ;;
  repos/Prowl-qa/app/pulls/7)
    if [[ "$*" == *'.base.sha'* ]]; then
      printf 'base-sha\\tci-head\\tcontributor/app\\tfalse\\tcontributor\\tCONTRIBUTOR\\n'
    else
      printf 'open\\tci-head\\n'
    fi
    ;;
  *)
    echo "unexpected gh call: $*" >&2
    exit 1
    ;;
esac
`
        );
        chmodSync(join(bin, "jq"), 0o755);
        chmodSync(join(bin, "gh"), 0o755);

        execFileSync("bash", ["-c", resolve!.run], {
          cwd: temp,
          env: {
            ...process.env,
            PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
            GITHUB_OUTPUT: output,
            GITHUB_REPOSITORY: "Prowl-qa/app",
            PR_PAYLOAD: JSON.stringify([{ number: 7 }]),
            RUN_ID: "123",
            HEAD_SHA: "ci-head",
            CHECK_RUN: "true"
          },
          stdio: "pipe"
        });

        expect(outputMap(output)).toMatchObject({
          resolved: "false",
          pr_number: "7",
          head_sha: "ci-head",
          check_head_sha: "ci-head",
          check_conclusion: "neutral",
          check_title: "Fork pull request - review skipped"
        });
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    }
  );

  it.each(AUTO_REVIEW_TEMPLATES)(
    "$label auto-review records a neutral replacement check before skipping unapproved same-repo authors",
    ({ read: readFn }) => {
      const doc = parseYaml(readFn()) as {
        jobs: { resolve: { steps: Array<Record<string, unknown>> } };
      };
      const resolve = doc.jobs.resolve.steps.find((step) => step.id === "pr") as { run: string } | undefined;
      expect(resolve).toBeDefined();

      const temp = mkdtempSync(join(tmpdir(), "prowl-review-author-skip-"));
      try {
        const bin = join(temp, "bin");
        const output = join(temp, "github-output");
        mkdirSync(bin);
        writeFileSync(
          join(bin, "jq"),
          `#!/usr/bin/env bash
set -euo pipefail
cat >/dev/null
printf '9\\n'
`
        );
        writeFileSync(
          join(bin, "gh"),
          `#!/usr/bin/env bash
set -euo pipefail
url="$2"
case "$url" in
  repos/Prowl-qa/app/actions/runs/123)
    ;;
  repos/Prowl-qa/app/pulls/9)
    if [[ "$*" == *'.base.sha'* ]]; then
      printf 'base-sha\\tci-head\\tProwl-qa/app\\tfalse\\tintruder\\tCOLLABORATOR\\n'
    else
      printf 'open\\tci-head\\n'
    fi
    ;;
  *)
    echo "unexpected gh call: $*" >&2
    exit 1
    ;;
esac
`
        );
        chmodSync(join(bin, "jq"), 0o755);
        chmodSync(join(bin, "gh"), 0o755);

        execFileSync("bash", ["-c", resolve!.run], {
          cwd: temp,
          env: {
            ...process.env,
            PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
            GITHUB_OUTPUT: output,
            GITHUB_REPOSITORY: "Prowl-qa/app",
            PR_PAYLOAD: JSON.stringify([{ number: 9 }]),
            RUN_ID: "123",
            HEAD_SHA: "ci-head",
            CHECK_RUN: "true",
            REQUIRE_APPROVED_ACTOR: "true",
            APPROVED_ACTORS: "octocat"
          },
          stdio: "pipe"
        });

        expect(outputMap(output)).toMatchObject({
          resolved: "false",
          pr_number: "9",
          head_sha: "ci-head",
          check_head_sha: "ci-head",
          check_conclusion: "neutral",
          check_title: "Review skipped - unauthorized actor"
        });
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    }
  );

  it.each(AUTO_REVIEW_TEMPLATES)(
    "$label auto-review records a failed replacement check when PR metadata lookup fails",
    ({ read: readFn }) => {
      const doc = parseYaml(readFn()) as {
        jobs: { resolve: { steps: Array<Record<string, unknown>> } };
      };
      const resolve = doc.jobs.resolve.steps.find((step) => step.id === "pr") as { run: string } | undefined;
      expect(resolve).toBeDefined();

      const temp = mkdtempSync(join(tmpdir(), "prowl-review-api-failure-"));
      try {
        const bin = join(temp, "bin");
        const output = join(temp, "github-output");
        mkdirSync(bin);
        writeFileSync(
          join(bin, "jq"),
          `#!/usr/bin/env bash
set -euo pipefail
cat >/dev/null
printf '7\\n'
`
        );
        writeFileSync(
          join(bin, "gh"),
          `#!/usr/bin/env bash
set -euo pipefail
url="$2"
case "$url" in
  repos/Prowl-qa/app/actions/runs/123)
    ;;
  repos/Prowl-qa/app/pulls/7)
    exit 22
    ;;
  *)
    echo "unexpected gh call: $*" >&2
    exit 1
    ;;
esac
`
        );
        chmodSync(join(bin, "jq"), 0o755);
        chmodSync(join(bin, "gh"), 0o755);

        execFileSync("bash", ["-c", resolve!.run], {
          cwd: temp,
          env: {
            ...process.env,
            PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
            GITHUB_OUTPUT: output,
            GITHUB_REPOSITORY: "Prowl-qa/app",
            PR_PAYLOAD: JSON.stringify([{ number: 7 }]),
            RUN_ID: "123",
            HEAD_SHA: "ci-head",
            CHECK_RUN: "true"
          },
          stdio: "pipe"
        });

        expect(outputMap(output)).toMatchObject({
          resolved: "false",
          pr_number: "7",
          head_sha: "ci-head",
          check_head_sha: "ci-head",
          check_conclusion: "failure",
          check_title: "Review setup failed"
        });
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    }
  );

  it.each(AUTO_REVIEW_TEMPLATES)("$label auto-review keys concurrency off the resolved PR number", ({ label, read: readFn }) => {
    const text = readFn();
    const doc = parseYaml(text) as {
      jobs: {
        review: { needs: string; concurrency: Record<string, unknown> };
        "report-unreviewable": { needs: string; concurrency: Record<string, unknown> };
      };
    };
    expect(doc.jobs.review.needs).toBe("resolve");
    if (label === "dogfood") {
      // Self-hosted Codex dogfood (#64): per-PR + per-repo group shared
      // with commands, but non-cancelling so maintainer requests are not
      // interrupted. Machine-wide serialization is the Codex lock.
      expect(doc.jobs.review.concurrency).toMatchObject({
        group: "prowl-review-codex-${{ github.repository }}-${{ needs.resolve.outputs.pr_number }}",
        "cancel-in-progress": false
      });
    } else {
      expect(doc.jobs.review.concurrency).toMatchObject({
        group: "prowl-review-${{ needs.resolve.outputs.pr_number }}",
        "cancel-in-progress": false
      });
    }
    expect(doc.jobs["report-unreviewable"].needs).toBe("resolve");
    expect(doc.jobs["report-unreviewable"].concurrency).toMatchObject({
      group: "prowl-review-${{ needs.resolve.outputs.pr_number || needs.resolve.outputs.check_head_sha }}",
      "cancel-in-progress": false
    });
  });

  it("the action declares pr-number and forwards it as --pr", () => {
    const action = parseYaml(readRepo("action.yml")) as { inputs: Record<string, unknown> };
    // The workflow_run PR handoff input the availability gate greps for (#61).
    expect(action.inputs).toHaveProperty("pr-number");
    expect(action.inputs).toHaveProperty("pr-draft");
    const text = readRepo("action.yml");
    expect(text).toContain("PROWL_INPUT_PR_NUMBER: ${{ inputs.pr-number }}");
    expect(text).toContain("PROWL_REVIEWED_PR_DRAFT: ${{ inputs.pr-draft || env.PROWL_REVIEWED_PR_DRAFT }}");
    expect(text).toContain("PROWL_CHECK_RUN_ID: ${{ env.PROWL_CHECK_RUN_ID }}");
    expect(text).toContain("pr_args+=(--pr");
  });

  it("the dogfood availability gate self-bootstraps on the workflow_run handoff", () => {
    const text = readRepo(".github/workflows/prowl-review.yml");
    // Won't run an old base action that lacks the workflow_run handoff (#61) or the
    // keyless Codex provider (#45/#64) — it self-bootstraps once this PR merges to
    // the base (the ai-provider input replaces the old ensemble-key grep).
    expect(text).toContain("grep -q 'pr-number' \"${action_file}\"");
    expect(text).toContain("grep -q 'pr-draft' \"${action_file}\"");
    expect(text).toContain("grep -q 'ai-provider' \"${action_file}\"");
    // Also require the base action to actually mention `codex`, so the guard proves
    // `provider: codex` support and not merely the presence of an ai-provider input.
    expect(text).toContain("grep -q 'codex' \"${action_file}\"");
    expect(text).not.toContain("grep -q 'ai-key-anthropic' \"${action_file}\"");
  });
});

// Self-hosted, subscription-backed dogfood reviews (#64). The review/command jobs
// run keyless `provider: codex` on the Mac mini runner; fork/author gates stay
// on hosted runners and no provider secret reaches the self-hosted job.
describe("self-hosted Codex dogfood (#64)", () => {
  const SELF_HOSTED_LABELS = ["self-hosted", "macOS", "prowl-review"];

  it("the dogfood auto-review job runs on the self-hosted Codex runner with a timeout", () => {
    const doc = parseYaml(readRepo(".github/workflows/prowl-review.yml")) as {
      jobs: Record<string, { "runs-on"?: unknown; "timeout-minutes"?: unknown }>;
    };
    // Only the review job moves to the runner; the fork/author resolve + the
    // neutral-check report job stay on hosted runners (no secrets, fork-safe).
    expect(doc.jobs.review["runs-on"]).toEqual(SELF_HOSTED_LABELS);
    expect(doc.jobs.review["timeout-minutes"]).toBe(30);
    expect(doc.jobs.resolve["runs-on"]).toBe("ubuntu-latest");
    expect(doc.jobs["report-unreviewable"]["runs-on"]).toBe("ubuntu-latest");
  });

  it("the dogfood auto-review passes keyless codex and drops the API-key inputs", () => {
    const doc = parseYaml(readRepo(".github/workflows/prowl-review.yml")) as {
      jobs: { review: { steps: Array<Record<string, unknown>> } };
    };
    const reviewStep = doc.jobs.review.steps.find((step) => step.name === "prowl-review") as {
      with: Record<string, unknown>;
    };
    expect(reviewStep.with["ai-provider"]).toBe("codex");
    expect(reviewStep.with).not.toHaveProperty("ai-key-anthropic");
    expect(reviewStep.with).not.toHaveProperty("ai-key-gemini");
    // No provider secret is referenced anywhere in the self-hosted review job.
    const text = readRepo(".github/workflows/prowl-review.yml");
    expect(text).not.toContain("PROWL_AI_KEY_ANTHROPIC");
    expect(text).not.toContain("PROWL_AI_KEY_GEMINI");
  });

  it("the dogfood command job runs codex on the self-hosted runner behind a same-repo gate", () => {
    const doc = parseYaml(readRepo(".github/workflows/prowl-review-command.yml")) as {
      jobs: {
        resolve: { "runs-on"?: unknown; if: string; concurrency: Record<string, unknown>; outputs: Record<string, unknown> };
        command: {
          "runs-on"?: unknown;
          if: string;
          needs: string;
          "timeout-minutes"?: unknown;
          concurrency: Record<string, unknown>;
          steps: Array<Record<string, unknown>>;
        };
      };
    };
    // The author-authorization gate lives on the ubuntu resolve job; the
    // self-hosted command job is gated on the same-repo verdict it produces.
    expect(doc.jobs.resolve["runs-on"]).toBe("ubuntu-latest");
    expect(doc.jobs.resolve.if).toContain("github.event.comment.author_association == 'OWNER'");
    expect(doc.jobs.command.needs).toBe("resolve");
    expect(doc.jobs.command["runs-on"]).toEqual(SELF_HOSTED_LABELS);
    expect(doc.jobs.command["timeout-minutes"]).toBe(30);
    expect(doc.jobs.resolve.concurrency).toMatchObject({
      group: "prowl-review-codex-${{ github.repository }}-${{ github.event.issue.number || github.event.pull_request.number }}",
      "cancel-in-progress": false
    });
    expect(doc.jobs.command.concurrency).toMatchObject({
      group: "prowl-review-codex-${{ github.repository }}-${{ needs.resolve.outputs.pr_number }}",
      "cancel-in-progress": false
    });
    expect(normalizeExpression(doc.jobs.command.if)).toBe(
      "needs.resolve.outputs.trusted_head == 'true' && needs.resolve.outputs.head_repo == github.repository"
    );
    const commandStep = doc.jobs.command.steps.find((step) => step.name === "prowl-review command") as {
      with: Record<string, unknown>;
    };
    expect(commandStep.with["ai-provider"]).toBe("codex");
    expect(commandStep.with).not.toHaveProperty("ai-key-anthropic");
  });

  it("both dogfood workflows serialize on the shared per-PR Codex concurrency group", () => {
    const autoText = readRepo(".github/workflows/prowl-review.yml");
    const autoDoc = parseYaml(autoText) as {
      jobs: { review: { concurrency: { "cancel-in-progress"?: unknown } } };
    };
    const commandDoc = parseYaml(readRepo(".github/workflows/prowl-review-command.yml")) as {
      concurrency?: unknown;
      jobs: {
        resolve: { concurrency: { group: string; "cancel-in-progress"?: unknown } };
        command: { concurrency: { group: string; "cancel-in-progress"?: unknown } };
      };
    };
    // Same group prefix keyed by repo + PR number, so an @prowl-review command and
    // an auto review of the same PR never publish concurrently.
    expect(autoText).toContain("group: prowl-review-codex-${{ github.repository }}-${{ needs.resolve.outputs.pr_number }}");
    expect(commandDoc.concurrency).toBeUndefined();
    expect(commandDoc.jobs.resolve.concurrency.group).toBe(
      "prowl-review-codex-${{ github.repository }}-${{ github.event.issue.number || github.event.pull_request.number }}"
    );
    expect(commandDoc.jobs.command.concurrency.group).toBe(
      "prowl-review-codex-${{ github.repository }}-${{ needs.resolve.outputs.pr_number }}"
    );
    // Maintainer commands are not cancelled by newer commands or auto reviews in
    // the shared group.
    expect(autoDoc.jobs.review.concurrency["cancel-in-progress"]).toBe(false);
    expect(commandDoc.jobs.resolve.concurrency["cancel-in-progress"]).toBe(false);
    expect(commandDoc.jobs.command.concurrency["cancel-in-progress"]).toBe(false);
  });

  const OPENAI_PUBLIC_CAVEAT = "Do not use this workflow for public or open-source repositories.";
  const SELF_HOSTED_EXAMPLES = [
    "examples/workflows/prowl-review-self-hosted-codex.yml",
    "examples/workflows/prowl-review-command-self-hosted-codex.yml"
  ] as const;

  it.each(SELF_HOSTED_EXAMPLES)("%s is repo-agnostic, keyless, and states the public-repo caveats", (path) => {
    const text = readRepo(path);
    expect(() => parseYaml(text)).not.toThrow();
    // Repo-agnostic: pins the published action, bakes in nothing prowl-tools-specific.
    expect(text).toContain("uses: prowl-tools/prowl-code-review@v1");
    expect(text).not.toContain("prowl-tools/prowl-code-review.git");
    expect(text).not.toContain("uses: ./");
    // Keyless codex; no provider secret referenced (the prose may name PROWL_AI_KEY*).
    expect(text).toContain("ai-provider: codex");
    expect(text).not.toContain("secrets.PROWL_AI_KEY");
    // Public-repo caveats stated verbatim + the private-repo fork-gate note.
    expect(text).toContain(OPENAI_PUBLIC_CAVEAT);
    expect(text).toMatch(/PRIVATE repos may drop the fork gate/i);
  });

  it("the self-hosted auto-review example resolves trust on ubuntu and serializes per PR", () => {
    const doc = parseYaml(readRepo("examples/workflows/prowl-review-self-hosted-codex.yml")) as {
      concurrency: { group: string; "cancel-in-progress"?: unknown };
      jobs: {
        resolve: { "runs-on"?: unknown; outputs: Record<string, unknown> };
        review: { if: string; needs: string; "runs-on"?: unknown; "timeout-minutes"?: unknown };
      };
    };
    expect(doc.jobs.resolve["runs-on"]).toBe("ubuntu-latest");
    expect(doc.jobs.resolve.outputs).toMatchObject({
      trusted_head: "${{ steps.pr.outputs.trusted_head }}",
      approved_actor: "${{ steps.pr.outputs.approved_actor }}"
    });
    expect(doc.jobs.review.needs).toBe("resolve");
    expect(normalizeExpression(doc.jobs.review.if)).toBe(
      "needs.resolve.outputs.trusted_head == 'true' && needs.resolve.outputs.approved_actor == 'true'"
    );
    expect(doc.jobs.review["runs-on"]).toEqual(["self-hosted", "macOS", "prowl-review"]);
    expect(doc.jobs.review["timeout-minutes"]).toBe(30);
    expect(doc.concurrency).toMatchObject({
      group: "prowl-review-codex-${{ github.repository }}-${{ github.event.pull_request.number }}",
      "cancel-in-progress": false
    });
  });

  it("the self-hosted command example resolves trust on ubuntu and runs codex on the runner", () => {
    const doc = parseYaml(readRepo("examples/workflows/prowl-review-command-self-hosted-codex.yml")) as {
      concurrency?: unknown;
      jobs: {
        resolve: { "runs-on"?: unknown; if: string; concurrency: Record<string, unknown> };
        command: { "runs-on"?: unknown; if: string; needs: string; "timeout-minutes"?: unknown; concurrency: Record<string, unknown> };
      };
    };
    expect(doc.concurrency).toBeUndefined();
    expect(doc.jobs.resolve["runs-on"]).toBe("ubuntu-latest");
    expect(doc.jobs.command.needs).toBe("resolve");
    expect(doc.jobs.command["runs-on"]).toEqual(["self-hosted", "macOS", "prowl-review"]);
    expect(doc.jobs.command["timeout-minutes"]).toBe(30);
    expect(doc.jobs.resolve.concurrency).toMatchObject({
      group: "prowl-review-codex-${{ github.repository }}-${{ github.event.issue.number }}",
      "cancel-in-progress": false
    });
    expect(doc.jobs.command.concurrency).toMatchObject({
      group: "prowl-review-codex-${{ github.repository }}-${{ github.event.issue.number }}",
      "cancel-in-progress": false
    });
    expect(normalizeExpression(doc.jobs.command.if)).toBe(
      "needs.resolve.outputs.trusted_head == 'true' && needs.resolve.outputs.head_repo == github.repository"
    );
  });
});
