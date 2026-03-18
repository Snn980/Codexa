// jest.config.js — Unit / integration test runner
// E2E testler için: e2e/jest.config.js
//
// Çözülen sorunlar:
//   - Jest coverage ayarı yok → collectCoverageFrom + thresholds
//   - testPathIgnorePatterns eksik

'use strict';

/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',

  testMatch: [
    // __tests__ klasörü (standart Jest pattern)
    '<rootDir>/src/**/__tests__/**/*.{ts,tsx}',
    // tests/ klasörü
    '<rootDir>/src/**/tests/**/*.{ts,tsx}',
    // _tests_ klasörü (yanlış adlandırılmış — __tests__ olmalı, geçici destek)
    '<rootDir>/src/**/_tests_/**/*.{ts,tsx}',
    // Inline test dosyaları
    '<rootDir>/src/**/*.{spec,test}.{ts,tsx}',
    '<rootDir>/__tests__/**/*.{ts,tsx}',
  ],

  testPathIgnorePatterns: [
    '/node_modules/',
    '/e2e/',
    '\\.e2e\\.ts$',
    '/android/',
    '/ios/',
  ],

  moduleNameMapper: {
    // Statik asset mock
    '\\.(png|jpg|jpeg|gif|webp|svg|wasm)$': '<rootDir>/__mocks__/fileMock.js',
    // Path alias (tsconfig paths ile senkron tut)
    '^@/(.*)$': '<rootDir>/src/$1',
  },

  transform: {
    '^.+\\.(ts|tsx)$': [
      'babel-jest',
      { configFile: './babel.config.js' },
    ],
  },

  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],

  // ── Coverage ──────────────────────────────────────────────────────────────

  collectCoverage: false, // --coverage flag ile aktifleştirilir (CI'da)

  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    // Tip dosyaları, index re-export'lar ve mock'lar hariç
    '!src/**/*.d.ts',
    '!src/**/index.ts',
    '!src/**/__mocks__/**',
    '!src/**/*.stories.{ts,tsx}',
    // Oluşturulan dosyalar
    '!src/generated/**',
  ],

  coverageDirectory: 'coverage',

  coverageReporters: ['text-summary', 'lcov', 'json'],

  // Minimum eşikler — Phase 13 baseline; ileride artırılır
  coverageThreshold: {
    global: {
      branches:   60,
      functions:  65,
      lines:      65,
      statements: 65,
    },
    // Kritik dosyalar için daha yüksek eşik
    './src/hooks/useAIChat.ts': {
      branches:   80,
      functions:  90,
      lines:      90,
      statements: 90,
    },
    './src/permission/PermissionGate.ts': {
      branches:   75,
      functions:  85,
      lines:      85,
      statements: 85,
    },
    './src/utils/uuid.ts': {
      branches:   90,
      functions:  100,
      lines:      95,
      statements: 95,
    },
  },

  // ── Diğer ────────────────────────────────────────────────────────────────

  clearMocks:           true,
  restoreMocks:         true,
  testTimeout:          10_000,
  maxWorkers:           '50%', // CI'da aşırı yük önlemi
  verbose:              false,
};
