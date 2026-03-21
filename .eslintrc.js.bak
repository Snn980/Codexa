// .eslintrc.js
//
// Sorun: eslint config görünmüyor → standart yok, kod kalitesi güvensiz.
// Çözüm: React Native + TypeScript + Hooks kuralları.

'use strict';

module.exports = {
  root: true,

  extends: [
    '@react-native',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
  ],

  parser: '@typescript-eslint/parser',

  parserOptions: {
    project:     './tsconfig.json',
    tsconfigRootDir: __dirname,
    ecmaVersion: 2022,
    ecmaFeatures: { jsx: true },
  },

  plugins: [
    '@typescript-eslint',
    'react-hooks',
    'import',
  ],

  rules: {
    // ── TypeScript ────────────────────────────────────────────────────────
    '@typescript-eslint/no-explicit-any':         'error',
    '@typescript-eslint/no-non-null-assertion':   'warn',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/no-floating-promises':    'error',
    '@typescript-eslint/no-misused-promises':     'error',
    '@typescript-eslint/require-await':           'warn',
    '@typescript-eslint/prefer-nullish-coalescing': 'warn',
    '@typescript-eslint/prefer-optional-chain':   'warn',

    // ── React Hooks (§ 8) ────────────────────────────────────────────────
    'react-hooks/rules-of-hooks':  'error',
    'react-hooks/exhaustive-deps': 'warn',

    // ── Import sırası ────────────────────────────────────────────────────
    'import/order': [
      'warn',
      {
        groups: [
          'builtin', 'external', 'internal',
          ['parent', 'sibling', 'index'],
        ],
        'newlines-between': 'always',
        alphabetize: { order: 'asc', caseInsensitive: true },
      },
    ],
    'import/no-cycle': 'error',   // Circular dependency koruması (§ liste)

    // ── Genel ─────────────────────────────────────────────────────────────
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    'eqeqeq':    ['error', 'always'],
    'no-shadow':  'off',
    '@typescript-eslint/no-shadow': 'error',
  },

  overrides: [
    // Test dosyaları için gevşetilmiş kurallar
    {
      files: ['**/__tests__/**/*.{ts,tsx}', '**/*.{spec,test}.{ts,tsx}', 'e2e/**/*.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any':       'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
        'no-console':                               'off',
      },
    },
    // Config dosyaları (JS, CommonJS)
    {
      files: ['*.config.js', '.eslintrc.js', '.detoxrc.js'],
      env:   { node: true },
      rules: {
        '@typescript-eslint/no-var-requires': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'off',
      },
    },
  ],

  ignorePatterns: [
    'node_modules/',
    'ios/',
    'android/',
    'coverage/',
    'src/generated/',
    '*.d.ts',
  ],
};
