/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',

  // ─── Timeout ──────────────────────────────────────────────────────────────
  testTimeout: 15_000,

  // ─── Async testler bitince process'i zorla kapat ──────────────────────────
  forceExit: true,

  // ─── Paralel worker sayısını sınırla (CI'da bellek taşmasını önler) ───────
  maxWorkers: 2,

  // ─── Setup dosyası ────────────────────────────────────────────────────────
  setupFilesAfterFramework: [],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],

  // ─── Transform ────────────────────────────────────────────────────────────
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg)',
  ],

  // ─── Test dosyaları ───────────────────────────────────────────────────────
  testMatch: [
    '**/__tests__/**/*.test.[jt]s?(x)',
    '**/?(*.)+(spec|test).[jt]s?(x)',
  ],

  // ─── Coverage ─────────────────────────────────────────────────────────────
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/__tests__/**',
    '!src/**/*.d.ts',
  ],
};
