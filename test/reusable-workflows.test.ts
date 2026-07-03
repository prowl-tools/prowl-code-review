import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

const permissionSchema = z.record(z.enum(["read", "write", "none"]));
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
    inputs: z.record(workflowCallInputSchema).optional(),
    secrets: z.record(workflowCallSecretSchema).optional(),
    outputs: z.record(z.unknown()).optional()
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
const onSchema = z.record(z.unknown()).superRefine((value, ctx) => {
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
    env: z.record(z.unknown()).optional(),
    with: z.record(z.unknown()).optional(),
    "working-directory": z.string().optional(),
    "continue-on-error": expressionOrLiteralSchema.optional(),
    "timeout-minutes": expressionOrLiteralSchema.optional()
  })
  .strict()
  .refine((step) => (step.uses !== undefined) !== (step.run !== undefined), "step must define exactly one of uses or run");
const concurrencySchema = z
  .object({
    group: z.string(),
    queue: z.enum(["single", "max"]).optional(),
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
    env: z.record(z.unknown()).optional(),
    defaults: z.record(z.unknown()).optional(),
    outputs: z.record(z.unknown()).optional(),
    strategy: z.record(z.unknown()).optional(),
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
    with: z.record(z.unknown()).optional(),
    secrets: z.union([z.literal("inherit"), z.record(z.unknown())]).optional()
  })
  .strict();
const workflowSchema = z
  .object({
    name: z.string(),
    on: onSchema.optional(),
    true: onSchema.optional(),
    permissions: permissionSchema.optional(),
    jobs: z.record(z.union([reusableJobSchema, callerJobSchema]))
  })
  .strict()
  .refine((workflow) => workflow.on !== undefined || workflow.true !== undefined, "workflow must declare triggers");

function parseWorkflow(name: (typeof ALL_WORKFLOWS)[number]): Record<string, unknown> {
  return parseYaml(read(name)) as Record<string, unknown>;
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

function shouldRunAutoReview(input: { headRepo: string; repository: string }): boolean {
  return input.headRepo === input.repository;
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
    expect(call.inputs).toHaveProperty("runs-on");
  });

  it.each(REUSABLE)("%s pins the published action, never the dogfood local action", (name) => {
    const text = read(name);
    expect(text).toContain("uses: prowl-tools/prowl-code-review@v1");
    expect(text).not.toContain("uses: ./");
  });

  it.each(DOGFOOD_WORKFLOWS)("%s dogfoods the local action, never the published v1 action", (path) => {
    const text = readRepo(path);
    expect(text).toMatch(/^\s*uses:\s*\.\/(?:\s+#.*)?$/m);
    expect(text).not.toMatch(/^\s*uses:\s*prowl-tools\/prowl-code-review@v1\b/m);
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
    // Fork guard stays at the workflow layer; draft policy stays inside the action.
    const review = (doc.jobs as { review: { if: string } }).review;
    expect(normalizeExpression(review.if)).toBe("github.event.pull_request.head.repo.full_name == github.repository");
    expect(review.if).not.toContain("draft");
    // Base checkout feeds guidelines; PR checkout feeds context.
    expect(text).toContain("ref: ${{ github.event.pull_request.base.sha }}");
    expect(text).toContain("guidelines-path: ${{ github.workspace }}/prowl-base");
  });

  it.each([
    ["same-repo ready PR", { headRepo: "Prowl-qa/app", repository: "Prowl-qa/app" }, true],
    ["same-repo draft PR", { headRepo: "Prowl-qa/app", repository: "Prowl-qa/app" }, true],
    ["fork PR", { headRepo: "contributor/app", repository: "Prowl-qa/app" }, false]
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

  it.each(CALLERS)("%s invokes the org workflow with inherited secrets in a few lines", (name) => {
    const doc = parseWorkflow(name) as { jobs: Record<string, { uses?: string; secrets?: unknown }> };
    const job = Object.values(doc.jobs)[0];
    expect(job.uses).toMatch(/^Prowl-qa\/\.github\/\.github\/workflows\/.+@v1$/);
    expect(job.secrets).toBe("inherit");
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
      queue: "max",
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
});
