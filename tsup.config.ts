import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli/index.ts",
    index: "src/index.ts"
  },
  format: ["esm", "cjs"],
  sourcemap: true,
  dts: { entry: { index: "src/index.ts" } },
  outDir: "dist",
  clean: true
});
