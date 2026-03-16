// e2e/jest.config.js
// § 27 — maxWorkers:1 | E2E (Detox) test runner config
//
// TAŞINDI: src/e2e/jest.config.js → e2e/jest.config.js
//   Detox bu dosyayı proje kökü yanındaki e2e/ klasöründe arar.
//   src/ altında olduğunda CI ve Detox CLI tarafından bulunamaz.
//
// Kullanım:
//   npx detox test --configuration ios.sim.debug
//   CI: jest --config e2e/jest.config.js

'use strict';

const TEST_TIMEOUT = Number(process.env.DETOX_TEST_TIMEOUT) || 120_000;

/** @type {import('@jest/types').Config.InitialOptions} */
module.exports = {
  rootDir:   '..',
  testMatch: ['<rootDir>/e2e/**/*.e2e.ts'],

  testTimeout: TEST_TIMEOUT,
  maxWorkers:  1,   // § 27 — simülatör tek thread

  globalSetup:    'detox/runners/jest/globalSetup',
  globalTeardown: 'detox/runners/jest/globalTeardown',
  reporters:      ['detox/runners/jest/reporter'],
  testEnvironment:'detox/runners/jest/testEnvironment',

  testPathIgnorePatterns: [
    '<rootDir>/node_modules/',
    '<rootDir>/src/',
    '<rootDir>/__tests__/',
  ],

  verbose: true,
  collectCoverage: false,
};
