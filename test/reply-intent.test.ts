import { describe, expect, it } from "vitest";
import {
  classifyReplyIntent,
  isResolvingIntent,
  isDisputingIntent,
  type ReplyIntent
} from "../src/review/reply-intent.js";

describe("classifyReplyIntent (#22)", () => {
  it.each([
    "I disagree with this",
    "this is a false positive",
    "false-positive",
    "not a real bug",
    "not a bug",
    "this is wrong",
    "that's incorrect",
    "I don't agree",
    "I do not think this applies"
  ])("classifies %j as disagree", (body) => {
    expect(classifyReplyIntent(body)).toBe("disagree");
  });

  it.each([
    "won't fix",
    "wont fix",
    "wontfix",
    "not going to fix this",
    "this is as-designed",
    "working as intended",
    "this is intentional",
    "by design"
  ])("classifies %j as wont-fix", (body) => {
    expect(classifyReplyIntent(body)).toBe("wont-fix");
  });

  it.each([
    "acknowledged",
    "noted, thanks",
    "got it",
    "good catch",
    "good point",
    "makes sense",
    "fixed in the next commit",
    "done",
    "will fix",
    "will address this"
  ])("classifies %j as acknowledged", (body) => {
    expect(classifyReplyIntent(body)).toBe("acknowledged");
  });

  it.each(["thanks", "ok", "hmm", "let me look", "", "interesting"])(
    "classifies %j as other",
    (body) => {
      expect(classifyReplyIntent(body)).toBe("other");
    }
  );

  it.each([
    "not fixed",
    "not resolved yet",
    "still not addressed",
    "this hasn't been fixed",
    "still unresolved"
  ])("does not treat negated completion %j as acknowledged", (body) => {
    expect(classifyReplyIntent(body)).toBe("other");
  });

  it("returns other for non-strings", () => {
    expect(classifyReplyIntent(undefined)).toBe("other");
    expect(classifyReplyIntent(null)).toBe("other");
  });

  it("prioritizes disagree over a co-occurring settle phrase", () => {
    // The dispute needs the most careful handling, so it wins.
    expect(classifyReplyIntent("I disagree, this is by design")).toBe("disagree");
    expect(classifyReplyIntent("disagree — won't fix")).toBe("disagree");
  });

  it("is case-insensitive", () => {
    expect(classifyReplyIntent("DISAGREE")).toBe("disagree");
    expect(classifyReplyIntent("Won't Fix")).toBe("wont-fix");
  });
});

describe("intent predicates (#22)", () => {
  const cases: Array<[ReplyIntent, boolean, boolean]> = [
    ["wont-fix", true, false],
    ["acknowledged", true, false],
    ["disagree", false, true],
    ["other", false, false]
  ];
  it.each(cases)("%s → resolving=%s disputing=%s", (intent, resolving, disputing) => {
    expect(isResolvingIntent(intent)).toBe(resolving);
    expect(isDisputingIntent(intent)).toBe(disputing);
  });
});
