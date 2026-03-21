const tsPlugin   = require("@typescript-eslint/eslint-plugin");
const tsParser   = require("@typescript-eslint/parser");
const reactHooks = require("eslint-plugin-react-hooks");

module.exports = [
  {
    ignores: [
      "node_modules/**", "ios/**", "android/**",
      "coverage/**", "src/generated/**", "**/*.d.ts",
    ],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      "react-hooks":        reactHooks,
    },
    rules: {
      "@typescript-eslint/no-explicit-any":      "warn",
      "@typescript-eslint/no-unused-vars":       ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises":  "off",
      "@typescript-eslint/no-shadow":            "off",
      "@typescript-eslint/require-await":        "off",
      "react-hooks/rules-of-hooks":              "warn",
      "react-hooks/exhaustive-deps":             "off",
      "no-console":                              "off",
      "eqeqeq":                                  ["warn", "always"],
    },
  },
  {
    files: ["**/__tests__/**/*.{ts,tsx}", "**/*.{spec,test}.{ts,tsx}", "e2e/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];
