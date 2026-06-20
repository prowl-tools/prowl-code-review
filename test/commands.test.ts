import { describe, expect, it } from "vitest";
import {
  parseCommand,
  commandHelpText,
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
    expect(parseCommand("@prowl-review pause")).toEqual({ verb: "pause", argument: "" });
    expect(parseCommand("@prowl-review resume")).toEqual({ verb: "resume", argument: "" });
    expect(parseCommand("@prowl-review help")).toEqual({ verb: "help", argument: "" });
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
        verb === "full-review" ? "full review" : verb === "break-glass" ? "break glass <head-sha>" : verb;
      expect(help).toContain(`\`${shown}\``);
    }
  });
});
