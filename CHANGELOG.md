# Changelog

All notable changes to Prowl Review will be documented in this file.

## [Unreleased]

### Added
- Initial TypeScript package scaffold mirroring `prowl`'s toolchain: ESM + strict
  `tsconfig`, `tsup` dual-entry build (CLI + library), ESLint + `@typescript-eslint`,
  and Vitest. Commander-based CLI (`prowl-review`) with a `--version`/`--help` surface
  and a placeholder `review` command. Apache-2.0 `LICENSE` + `NOTICE`. (backlog #1)
