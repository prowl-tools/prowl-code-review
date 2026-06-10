import { describe, expect, it } from "vitest";
import { buildProgram, CLI_VERSION } from "../src/cli/program.js";

describe("buildProgram", () => {
  it("configures the prowl-review program", () => {
    const program = buildProgram();
    expect(program.name()).toBe("prowl-review");
    expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("registers the review and eval commands", () => {
    const program = buildProgram();
    const names = program.commands.map((command) => command.name());
    expect(names).toContain("review");
    expect(names).toContain("eval");
  });
});
