import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

// Flat config (ESLint 9+). Mirrors the previous .eslintrc.cjs: eslint:recommended
// + @typescript-eslint/recommended over the TypeScript sources, Node globals, the
// vitest test globals, and the `_`-prefixed unused-arg allowance. Scoped to *.ts
// to match the old `--ext .ts` targeting (dist is built output, so it's ignored).
export default tseslint.config(
  { ignores: ["dist/**"] },
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
        describe: "readonly",
        it: "readonly",
        expect: "readonly",
        vi: "readonly"
      }
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }]
    }
  }
);
