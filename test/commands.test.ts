import { describe, expect, it } from "vitest";
import {
  parseCommand,
  commandHelpText,
  parseConfigureArgs,
  configureHelpText,
  isTrustedCommandAuthor,
  COMMAND_VERBS
} from "../src/review/commands.js";

describe("parseCommand (#26)", () => {
  it("returns null when the bot isn't mentioned", () => {
    expect(parseCommand("looks good to me")).toBeNull();
    expect(parseCommand("")).toBeNull();
    expect(parseCommand(undefined)).toBeNull();
  });

  it("parses each known verb", () => {
    expect(parseCommand("@prowl-review review")).toEqual({ verb: "review", argument: "" });
    expect(parseCommand("@prowl-review ignore")).toEqual({ verb: "ignore", argument: "" });
    expect(parseCommand("@prowl-review resolve")).toEqual({ verb: "resolve", argument: "" });
    expect(parseCommand("@prowl-review pause")).toEqual({ verb: "pause", argument: "" });
    expect(parseCommand("@prowl-review resume")).toEqual({ verb: "resume", argument: "" });
    expect(parseCommand("@prowl-review help")).toEqual({ verb: "help", argument: "" });
  });

  it("parses `configure` with its settings as the argument (#26)", () => {
    expect(parseCommand("@prowl-review configure minSeverity=major verify=off")).toEqual({
      verb: "configure",
      argument: "minSeverity=major verify=off"
    });
    expect(parseCommand("@prowl-review configure reset")).toEqual({ verb: "configure", argument: "reset" });
  });

  it("treats `full review` and `full-review` as a full re-scan", () => {
    expect(parseCommand("@prowl-review full review")).toEqual({ verb: "full-review", argument: "" });
    expect(parseCommand("@prowl-review full-review")).toEqual({ verb: "full-review", argument: "" });
  });

  it("treats break-glass aliases as approval override reviews", () => {
    expect(parseCommand("@prowl-review break glass abc123")).toEqual({ verb: "break-glass", argument: "abc123" });
    expect(parseCommand("@prowl-review break-glass abc123")).toEqual({ verb: "break-glass", argument: "abc123" });
    expect(parseCommand("@prowl-review breakglass abc123")).toEqual({ verb: "break-glass", argument: "abc123" });
  });

  it("parses the docstrings/tests generation verbs and their aliases (#33)", () => {
    expect(parseCommand("@prowl-review docstrings")).toEqual({ verb: "docstrings", argument: "" });
    expect(parseCommand("@prowl-review docstring")).toEqual({ verb: "docstrings", argument: "" });
    expect(parseCommand("@prowl-review docs")).toEqual({ verb: "docstrings", argument: "" });
    expect(parseCommand("@prowl-review doc")).toEqual({ verb: "docstrings", argument: "" });
    expect(parseCommand("@prowl-review tests")).toEqual({ verb: "tests", argument: "" });
    expect(parseCommand("@prowl-review test")).toEqual({ verb: "tests", argument: "" });
  });

  it("maps a bare mention to help", () => {
    expect(parseCommand("@prowl-review")).toEqual({ verb: "help", argument: "" });
  });

  it("classifies an unknown verb as unknown (→ help)", () => {
    expect(parseCommand("@prowl-review frobnicate")).toEqual({ verb: "unknown", argument: "frobnicate" });
  });

  it("preserves multiline free-form chat questions after the mention", () => {
    expect(parseCommand("@prowl-review why did this change?\n\n```ts\nfoo();\n```")).toEqual({
      verb: "unknown",
      argument: "why did this change?\n\n```ts\nfoo();\n```"
    });
  });

  it("treats a mention followed by later text as a free-form chat question", () => {
    expect(parseCommand("@prowl-review\nwhy did this change?")).toEqual({
      verb: "unknown",
      argument: "why did this change?"
    });
  });

  it("is case-insensitive on the mention and verb", () => {
    expect(parseCommand("@Prowl-Review REVIEW")?.verb).toBe("review");
  });

  it("ignores text around the mention and captures trailing args", () => {
    expect(parseCommand("hey @prowl-review review please")).toEqual({ verb: "review", argument: "please" });
  });

  it("only reads the mention's own line", () => {
    expect(parseCommand("@prowl-review pause\nthanks!")).toEqual({ verb: "pause", argument: "" });
  });

  it("does not treat a verb without the mention as a command", () => {
    expect(parseCommand("please review this")).toBeNull();
  });
});

describe("isTrustedCommandAuthor (#26)", () => {
  it.each(["OWNER", "MEMBER", "COLLABORATOR"])("trusts %s", (assoc) => {
    expect(isTrustedCommandAuthor(assoc)).toBe(true);
  });
  it.each(["CONTRIBUTOR", "NONE", "FIRST_TIME_CONTRIBUTOR", undefined, null])(
    "does not trust %s",
    (assoc) => {
      expect(isTrustedCommandAuthor(assoc as string | undefined)).toBe(false);
    }
  );
});

describe("commandHelpText (#26)", () => {
  it("lists every supported verb", () => {
    const help = commandHelpText();
    for (const verb of COMMAND_VERBS) {
      // Multiword commands are shown in prose.
      const shown =
        verb === "full-review"
          ? "full review"
          : verb === "break-glass"
            ? "break glass <head-sha>"
            : verb === "configure"
              ? "configure <key=value …>"
              : verb;
      expect(help).toContain(`\`${shown}\``);
    }
  });
});

describe("parseConfigureArgs (#26)", () => {
  it("parses the allowlisted settings with validation", () => {
    expect(parseConfigureArgs("minSeverity=major maxFindings=10 verify=off")).toEqual({
      reset: false,
      overrides: { minSeverity: "major", maxFindings: 10, verify: false },
      errors: [],
      empty: false
    });
  });

  it("accepts comma separators and verify truthy/falsy aliases", () => {
    expect(parseConfigureArgs("minSeverity=critical, verify=on").overrides).toEqual({
      minSeverity: "critical",
      verify: true
    });
  });

  it("treats a lone `reset` as a clear", () => {
    expect(parseConfigureArgs("reset")).toMatchObject({ reset: true, empty: false });
  });

  it("reports an error for an unknown key", () => {
    const parsed = parseConfigureArgs("minConfidence=0.9");
    expect(parsed.overrides).toEqual({});
    expect(parsed.errors[0]).toContain("Unknown setting");
    expect(parsed.empty).toBe(true);
  });

  it("reports errors for invalid values without applying them", () => {
    expect(parseConfigureArgs("minSeverity=urgent").errors[0]).toContain("Invalid minSeverity");
    expect(parseConfigureArgs("maxFindings=0").errors[0]).toContain("Invalid maxFindings");
    expect(parseConfigureArgs("maxFindings=-3").errors[0]).toContain("Invalid maxFindings");
    expect(parseConfigureArgs("verify=maybe").errors[0]).toContain("Invalid verify");
    expect(parseConfigureArgs("nonsense").errors[0]).toContain("key=value");
  });

  it("keeps valid settings and reports every error for mixed tokens", () => {
    const parsed = parseConfigureArgs("minSeverity=major unknownKey=foo maxFindings=abc verify=on");
    expect(parsed.overrides).toEqual({ minSeverity: "major", verify: true });
    expect(parsed.errors).toHaveLength(2);
    expect(parsed.errors[0]).toContain("Unknown setting");
    expect(parsed.errors[1]).toContain("Invalid maxFindings");
    expect(parsed.empty).toBe(false);
  });

  it("flags empty input (no settings, no reset)", () => {
    expect(parseConfigureArgs("")).toMatchObject({ reset: false, empty: true });
  });
});

describe("configureHelpText (#26)", () => {
  it("lists the supported settings and prepends any errors", () => {
    const help = configureHelpText(["Invalid minSeverity `x`."]);
    expect(help).toContain("Invalid minSeverity `x`.");
    expect(help).toContain("minSeverity");
    expect(help).toContain("maxFindings");
    expect(help).toContain("verify");
    expect(help).toContain("reset");
  });
});
