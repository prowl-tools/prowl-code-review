module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true
  },
  globals: {
    describe: "readonly",
    it: "readonly",
    expect: "readonly",
    vi: "readonly"
  },
  parser: "@typescript-eslint/parser",
  parserOptions: {
    sourceType: "module"
  },
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  rules: {
    "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }]
  }
};
