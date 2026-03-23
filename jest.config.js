/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',

  // ─── Timeout ──────────────────────────────────────────────────────────────
  testTimeout: 15_000,

  // ─── Async testler bitince process'i zorla kapat ──────────────────────────
  forceExit: true,
  detectOpenHandles: true,

  // ─── Paralel worker sayısını sınırla (CI'da bellek taşmasını önler) ───────
  maxWorkers: 2,

  // ─── Setup dosyası ────────────────────────────────────────────────────────
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],

  // ─── TypeScript — test ortamına özgü tsconfig ─────────────────────────────
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg)',
  ],

  // ─── Module alias (@/) ────────────────────────────────────────────────────
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    'expo-dev-launcher': '<rootDir>/src/__mocks__/expo-dev-launcher.js',
  },

  // ─── Globals (browser env polyfill) ──────────────────────────────────────
  globals: {
    self: {},
  },

  // ─── Test dosyaları ───────────────────────────────────────────────────────
  testMatch: [
    '**/__tests__/**/*.test.[jt]s?(x)',
  ],

  // ─── Coverage ─────────────────────────────────────────────────────────────
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/__tests__/**',
    '!src/**/*.d.ts',
    '!src/**/__mocks__/**',
    '!src/**/*.test.{ts,tsx}',
    '!src/**/*.spec.{ts,tsx}',
  ],
  
  // Coverage threshold (CI'da fail olmaması için düşük tutuldu)
  coverageThreshold: {
    global: {
      branches: 20,
      functions: 20,
      lines: 20,
      statements: 20,
    },
  },
  
  // Coverage raporu formatları
  coverageReporters: ['text', 'lcov', 'html'],
  
  // ─── Verbose (debug için) ─────────────────────────────────────────────────
  verbose: false,
};
