#!/usr/bin/env node
import { buildProgram } from "./program.js";

const program = buildProgram();

program.parseAsync(process.argv).catch((error) => {
  const message = error instanceof Error ? error.message : "Command failed";
  console.error(message);
  process.exit(1);
});
