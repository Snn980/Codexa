const { defineConfig } = require("eslint/config");

module.exports = defineConfig([
  {
    ignores: [
      "node_modules/**",
      "android/**",
      "ios/**",
      "dist/**",
      "*.config.js",
      "babel.config.js",
      "metro.config.js",
      "jest.config.js",
    ],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: require("@typescript-eslint/parser"),
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "@typescript-eslint": require("@typescript-eslint/eslint-plugin"),
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-console": "off",
    },
  },
]);
