#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Extract a single version's release notes from CHANGELOG.md (#42).
 *
 * The publish workflow runs `node scripts/changelog-section.mjs <version>` to
 * produce the body of the GitHub Release for tag `v<version>`. It looks for a
 * `## [<version>]` heading and returns everything up to the next `## ` heading;
 * if there isn't a versioned section yet it falls back to the `## [Unreleased]`
 * section so a first release still gets meaningful notes.
 *
 * Pure + exported so it can be unit-tested without the filesystem.
 */

/** Escape a string for use inside a RegExp. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Return the release-notes body for `version` from `changelog` markdown.
 * Tries `## [version]` first, then `## [Unreleased]`. Returns a trimmed string;
 * falls back to a generic line when nothing usable is found.
 */
export function extractChangelogSection(changelog, version) {
  const normalized = String(version).trim().replace(/^v/, "");
  const section =
    (normalized.length > 0
      ? findSection(
          changelog,
          new RegExp(`^##\\s+\\[?${escapeRegExp(normalized)}\\]?(?=\\s+-\\s+|\\s*$)`, "m"),
        )
      : null) ??
    findSection(changelog, /^##\s+\[?Unreleased\]?/im);
  const body = section?.trim();
  if (body && body.length > 0) {
    return body;
  }
  return normalized.length > 0 ? `Release ${normalized}.` : "Release.";
}

/** Return the lines under the first heading matching `headingRe`, up to the next `## ` heading. */
function findSection(changelog, headingRe) {
  const lines = String(changelog).split(/\r?\n/);
  const start = lines.findIndex((line) => headingRe.test(line));
  if (start === -1) {
    return null;
  }
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##(?:\s+|\[)/.test(lines[i])) {
      break;
    }
    body.push(lines[i]);
  }
  return body.join("\n");
}

// CLI: `node scripts/changelog-section.mjs <version> [path]` -> prints notes to stdout.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  if (!version) {
    console.error("usage: changelog-section.mjs <version> [changelog-path]");
    process.exit(2);
  }
  const path = process.argv[3] ?? "CHANGELOG.md";
  let changelog = "";
  try {
    changelog = readFileSync(path, "utf8");
  } catch {
    changelog = "";
  }
  process.stdout.write(`${extractChangelogSection(changelog, version)}\n`);
}
