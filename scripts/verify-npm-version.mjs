#!/usr/bin/env node

import { fileURLToPath } from "node:url";

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(value) {
  const version = String(value).trim();
  const match = VERSION_RE.exec(version);
  if (!match) {
    throw new Error(`unable to parse npm version: ${value}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) {
      return a[key] > b[key] ? 1 : -1;
    }
  }
  return 0;
}

export function satisfiesMinimumVersion(actual, minimum) {
  return compareVersions(actual, minimum) >= 0;
}

function main() {
  const actual = process.argv[2];
  const minimum = process.argv[3];
  if (!actual || !minimum) {
    console.error("usage: verify-npm-version.mjs <actual-version> <minimum-version>");
    process.exit(2);
  }

  try {
    if (!satisfiesMinimumVersion(actual, minimum)) {
      console.error(`::error::npm upgrade failed or incomplete; got ${actual}, need >=${minimum}.`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
