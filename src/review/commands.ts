/**
 * Bot command parsing (backlog #26).
 *
 * Developers drive the reviewer from the PR by commenting `@prowl-review <verb>`.
 * This module is the pure, conservative parser + verb allowlist (#14): it never
 * executes anything, just classifies a comment body into a known verb (or
 * `unknown`, so the caller can reply with help). The GitHub side — reading the
 * comment event, trust-gating the author, and dispatching — lives in the CLI
 * `command` handler.
 *
 * Trust: only repo owners/members/collaborators may drive the bot, mirroring the
 * break-glass gate (#52). An untrusted commenter's `@prowl-review` is ignored.
 */

/** Verbs the bot honors today. Anything else parses to `unknown` (→ chat/help). */
export const COMMAND_VERBS = ["review", "full-review", "break-glass", "ignore", "pause", "resume", "help"] as const;

/** A recognized bot command verb. */
export type CommandVerb = (typeof COMMAND_VERBS)[number];

/** GitHub author associations trusted to drive the bot (mirrors break-glass, #52). */
export const TRUSTED_COMMAND_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** A parsed `@prowl-review` command: a known verb, or `unknown` for an unrecognized one. */
export interface ParsedCommand {
  /** The recognized verb, or `unknown` when the text after the mention isn't one. */
  verb: CommandVerb | "unknown";
  /** Any text following the verb (reserved for future argument-bearing verbs). */
  argument: string;
}

/** The bot mention that prefixes every command. */
const MENTION_RE = /@prowl-review\b/i;

/** True when `association` is allowed to drive the bot. */
export function isTrustedCommandAuthor(association: string | null | undefined): boolean {
  return typeof association === "string" && TRUSTED_COMMAND_ASSOCIATIONS.has(association);
}

/**
 * Parse an `@prowl-review` command from a comment body. Returns null when the
 * comment doesn't mention the bot at all; otherwise a {@link ParsedCommand} whose
 * `verb` is an allowlisted verb or `unknown`. A bare mention (`@prowl-review`)
 * maps to `help`. Conservative: only an exact known verb is honored.
 */
export function parseCommand(body: string | null | undefined): ParsedCommand | null {
  if (typeof body !== "string") {
    return null;
  }
  const match = MENTION_RE.exec(body);
  if (!match) {
    return null;
  }

  const afterMention = body.slice(match.index + match[0].length);
  const mentionLine = afterMention.split(/\r?\n|\r/, 1)[0] ?? "";
  const tokens = mentionLine.trim().split(/\s+/).filter(Boolean);
  const freeformArgument = afterMention.trim();
  if (tokens.length === 0) {
    return freeformArgument ? { verb: "unknown", argument: freeformArgument } : { verb: "help", argument: "" };
  }

  const first = tokens[0].toLowerCase();
  // "full review" (two words) and "full-review" both mean a forced full re-scan.
  if ((first === "full" && tokens[1]?.toLowerCase() === "review") || first === "full-review") {
    const consumed = first === "full" ? 2 : 1;
    return { verb: "full-review", argument: tokens.slice(consumed).join(" ") };
  }

  if (
    (first === "break" && tokens[1]?.toLowerCase() === "glass") ||
    first === "break-glass" ||
    first === "breakglass"
  ) {
    const consumed = first === "break" ? 2 : 1;
    return { verb: "break-glass", argument: tokens.slice(consumed).join(" ") };
  }

  if ((COMMAND_VERBS as readonly string[]).includes(first)) {
    return { verb: first as CommandVerb, argument: tokens.slice(1).join(" ") };
  }

  return { verb: "unknown", argument: freeformArgument };
}

/** The help reply listing the supported commands. */
export function commandHelpText(): string {
  return [
    "**prowl-review commands** — comment `@prowl-review <command>`:",
    "",
    "- `review` — re-review the latest changes (incremental).",
    "- `full review` — re-scan the entire PR from scratch.",
    "- `break glass <head-sha>` — re-run the approval gate after a trusted override.",
    "- `ignore` — reply on a finding to mute it; it won't be raised again on this PR.",
    "- `pause` — stop auto-reviewing this PR on new pushes.",
    "- `resume` — re-enable auto-review.",
    "- `help` — show this message.",
    "",
    "_Only a repository owner, member, or collaborator can drive the bot._"
  ].join("\n");
}
