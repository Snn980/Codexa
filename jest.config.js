/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',

  // ─── FIX: ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG ─────────────────────
  // dynamic import() testlerde çalışsın — NODE_OPTIONS yerine config'de tanımlanır
  // böylece 'npx jest' ve 'npm test' her ikisinde de çalışır.
  experimentalVmModules: true,

  // ─── Timeout ──────────────────────────────────────────────────────────────
  testTimeout: 15_000,

  // ─── Async testler bitince process'i zorla kapat ──────────────────────────
  forceExit: true,
  detectOpenHandles: true,

  // ─── Paralel worker sayısını sınırla ──────────────────────────────────────
  maxWorkers: 2,

  // ─── Setup dosyası ────────────────────────────────────────────────────────
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],

  // ─── Transform ────────────────────────────────────────────────────────────
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg|@react-native-ai)',
  ],

  // ─── Module alias (@/) ────────────────────────────────────────────────────
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    'expo-dev-launcher': '<rootDir>/src/__mocks__/expo-dev-launcher.js',
    '^react-test-renderer$': '<rootDir>/src/__mocks__/react-test-renderer.js',
    // @react-native-ai/mlc — native modül, test'te global mock
    '^@react-native-ai/mlc$': '<rootDir>/src/__mocks__/@react-native-ai/mlc.js',
    // Vercel AI SDK
    '^ai$': '<rootDir>/src/__mocks__/ai.js',
  },

  // ─── Globals ──────────────────────────────────────────────────────────────
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

  coverageThreshold: {
    global: {
      branches: 20,
      functions: 20,
      lines: 20,
      statements: 20,
    },
  },

  coverageReporters: ['text', 'lcov', 'html'],
  verbose: false,
};
