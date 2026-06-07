# prowl-review — Resolved Items

Completed backlog items are moved here (with a completion date) by `/update-backlog` and the `/kickoff` lifecycle. See [`docs/backlog.md`](./backlog.md) for active work.

Format: `- **Item title** (completed: YYYY-MM-DD) — short note / commit or PR ref`

---

- **#1 TypeScript package scaffold matching `prowl`** (completed: 2026-06-07) — TS toolchain mirroring `prowl` (ESM, strict `tsconfig`, `tsup` dual-entry build, ESLint + `@typescript-eslint`, Vitest); Commander CLI (`prowl-review`) with `--version`/`--help` + a placeholder `review` command; Apache-2.0 `LICENSE` + `NOTICE`; `CHANGELOG` seeded. Build → `dist/cli.js`, lint clean, tests green. Branch `scaffold` (`d55ca2e`…`498d88a`).
