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

import type { Severity } from "./findings.js";

/** Verbs the bot honors today. Anything else parses to `unknown` (→ chat/help). */
export const COMMAND_VERBS = [
  "review",
  "full-review",
  "break-glass",
  "ignore",
  "resolve",
  "configure",
  "pause",
  "resume",
  "docstrings",
  "tests",
  "help"
] as const;

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

  // Accept singular/`doc`/`docs` aliases for the #33 generation verbs.
  if (first === "docstring" || first === "docstrings" || first === "doc" || first === "docs") {
    return { verb: "docstrings", argument: tokens.slice(1).join(" ") };
  }
  if (first === "test" || first === "tests") {
    return { verb: "tests", argument: tokens.slice(1).join(" ") };
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
    "- `resolve` — reply on a finding to mark its thread resolved and stop re-raising it.",
    "- `configure <key=value …>` — set per-PR review settings (`minSeverity`, `maxFindings`, `verify`); `configure reset` clears them.",
    "- `pause` — stop auto-reviewing this PR on new pushes.",
    "- `resume` — re-enable auto-review.",
    "- `docstrings` — draft docstrings for the changed code.",
    "- `tests` — draft unit-test stubs for the changed code.",
    "- `help` — show this message.",
    "",
    "_Only a repository owner, member, or collaborator can drive the bot._"
  ].join("\n");
}

/** Per-PR review settings a trusted commenter may set via `@prowl-review configure` (#26). */
export interface ConfigureOverrides {
  minSeverity?: Severity;
  maxFindings?: number;
  verify?: boolean;
}

/** Parsed `@prowl-review configure` arguments. */
export interface ParsedConfigure {
  /** `configure reset` — clear all per-PR overrides. */
  reset: boolean;
  /** Recognized, validated overrides to apply. */
  overrides: ConfigureOverrides;
  /** Per-token validation errors (unknown key, bad value). */
  errors: string[];
  /** True when no recognizable settings (and not a reset) were supplied. */
  empty: boolean;
}

const CONFIGURE_SEVERITIES = new Set<Severity>(["critical", "major", "minor", "trivial", "info"]);

/**
 * Parse the argument of an `@prowl-review configure` command into validated
 * per-PR overrides. Conservative: only an allowlist of keys (`minSeverity`,
 * `maxFindings`, `verify`) is honored, each value is validated, and anything else
 * becomes an error the caller surfaces — so a typo never silently weakens reviews.
 * `configure reset` clears all overrides.
 */
export function parseConfigureArgs(argument: string | null | undefined): ParsedConfigure {
  const overrides: ConfigureOverrides = {};
  const errors: string[] = [];
  const tokens = (typeof argument === "string" ? argument : "")
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 1 && tokens[0].toLowerCase() === "reset") {
    return { reset: true, overrides, errors, empty: false };
  }

  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq <= 0) {
      errors.push(`Couldn't parse \`${token}\` — use \`key=value\`.`);
      continue;
    }
    const key = token.slice(0, eq).trim().toLowerCase();
    const value = token.slice(eq + 1).trim();
    if (key === "minseverity") {
      const severity = value.toLowerCase() as Severity;
      if (CONFIGURE_SEVERITIES.has(severity)) {
        overrides.minSeverity = severity;
      } else {
        errors.push(`Invalid minSeverity \`${value}\` — use critical | major | minor | trivial | info.`);
      }
    } else if (key === "maxfindings") {
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed > 0) {
        overrides.maxFindings = parsed;
      } else {
        errors.push(`Invalid maxFindings \`${value}\` — use a positive integer.`);
      }
    } else if (key === "verify") {
      const truthy = ["true", "on", "yes", "1"];
      const falsy = ["false", "off", "no", "0"];
      if (truthy.includes(value.toLowerCase())) {
        overrides.verify = true;
      } else if (falsy.includes(value.toLowerCase())) {
        overrides.verify = false;
      } else {
        errors.push(`Invalid verify \`${value}\` — use on/off.`);
      }
    } else {
      errors.push(`Unknown setting \`${key}\` — supported: minSeverity, maxFindings, verify (or \`reset\`).`);
    }
  }

  return { reset: false, overrides, errors, empty: Object.keys(overrides).length === 0 };
}

/** Usage reply for a malformed `@prowl-review configure` command. */
export function configureHelpText(errors: string[] = []): string {
  return [
    ...(errors.length > 0 ? [...errors, ""] : []),
    "**`@prowl-review configure`** — set per-PR review settings:",
    "",
    "- `minSeverity=<critical|major|minor|trivial|info>` — only surface findings at/above this severity",
    "- `maxFindings=<n>` — cap the number of findings",
    "- `verify=<on|off>` — toggle the false-positive verification pass",
    "- `reset` — clear all per-PR overrides",
    "",
    "Example: `@prowl-review configure minSeverity=major verify=off`",
    "_Only a repository owner, member, or collaborator can drive the bot._"
  ].join("\n");
}
