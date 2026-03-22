/**
 * jest.setup.ts — Jest global test ortamı kurulumu
 *
 * @testing-library/react-native v13.3.3 + React 19.2.4 + Jest 30
 * jest.config.js → setupFilesAfterEnv: ['<rootDir>/jest.setup.ts']
 */



// ─── Global timeout ────────────────────────────────────────────────────────
// Her test için default timeout (jest.config.js'deki testTimeout ile senkron)
jest.setTimeout(10_000);

// ─── Console filtresi ──────────────────────────────────────────────────────
// Test çıktısında beklenen uyarıları sustur
const IGNORED_WARNINGS = [
  'Warning: An update to',
  'Warning: Cannot update a component',
  'Warning: ReactDOM.render is no longer supported',
  // React 19 concurrent mode uyarıları
  'Warning: act(...)',
];

const originalWarn  = console.warn.bind(console);
const originalError = console.error.bind(console);

beforeAll(() => {
  console.warn = (...args: unknown[]) => {
    const msg = args[0]?.toString() ?? '';
    if (IGNORED_WARNINGS.some((w) => msg.includes(w))) return;
    originalWarn(...args);
  };

  console.error = (...args: unknown[]) => {
    const msg = args[0]?.toString() ?? '';
    if (IGNORED_WARNINGS.some((w) => msg.includes(w))) return;
    originalError(...args);
  };
});

afterAll(() => {
  console.warn  = originalWarn;
  console.error = originalError;
});
global.EXDevLauncher = null;
