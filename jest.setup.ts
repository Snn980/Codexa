/**
 * jest.setup.ts — Jest global test ortamı kurulumu
 *
 * @testing-library/react-native v13.3.3 + React 19.2.4 + Jest 30
 * jest.config.js → setupFilesAfterEnv: ['<rootDir>/jest.setup.ts']
 */

// ─── Global timeout takibi (open handles fix) ─────────────────────────────────
declare global {
  // eslint-disable-next-line no-var
  var __activeTimeouts: Set<NodeJS.Timeout> | undefined;
  // eslint-disable-next-line no-var
  var __activeControllers: Set<AbortController> | undefined;
}

// ─── 1. Timeout takibi ────────────────────────────────────────────────────────
const originalSetTimeout = global.setTimeout;
const originalClearTimeout = global.clearTimeout;

global.setTimeout = ((callback: (...args: any[]) => void, ms: number, ...args: any[]) => {
  const timeout = originalSetTimeout(callback, ms, ...args);
  
  if (!global.__activeTimeouts) {
    global.__activeTimeouts = new Set();
  }
  global.__activeTimeouts.add(timeout);
  
  return timeout;
}) as typeof setTimeout;

global.clearTimeout = ((timeout: NodeJS.Timeout) => {
  if (global.__activeTimeouts) {
    global.__activeTimeouts.delete(timeout);
  }
  return originalClearTimeout(timeout);
}) as typeof clearTimeout;

// ─── 2. AbortController takibi ────────────────────────────────────────────────
const OriginalAbortController = global.AbortController;

class TrackedAbortController extends OriginalAbortController {
  constructor() {
    super();
    if (!global.__activeControllers) {
      global.__activeControllers = new Set();
    }
    global.__activeControllers.add(this);
    
    // Abort olunca takipten çıkar
    this.signal.addEventListener('abort', () => {
      global.__activeControllers?.delete(this);
    });
  }
}

global.AbortController = TrackedAbortController as any;

// ─── 3. Global test timeout ───────────────────────────────────────────────────
jest.setTimeout(15_000);

// ─── 4. Console filtresi ──────────────────────────────────────────────────────
const IGNORED_WARNINGS = [
  'Warning: An update to',
  'Warning: Cannot update a component',
  'Warning: ReactDOM.render is no longer supported',
  'Warning: act(...)',
  // AIOrchestrator uyarıları (beklenen)
  'Low quality response but no escalation occurred',
  // BGProcessingTask uyarıları (simulator)
  'Schedule failed (normal in Simulator)',
];

const originalWarn = console.warn.bind(console);
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

// ─── 5. Her test öncesi hazırlık ──────────────────────────────────────────────
beforeEach(() => {
  // Timer'ları temizle
  jest.clearAllTimers?.();
});

// ─── 6. Her test sonrası temizlik ─────────────────────────────────────────────
afterEach(async () => {
  // Promise'lerin bitmesi için kısa bekle
  await new Promise(resolve => setTimeout(resolve, 10));
});

// ─── 7. Tüm testler sonrası open handles temizliği ────────────────────────────
afterAll(async () => {
  // 7.1 Tüm aktif timeout'ları temizle
  if (global.__activeTimeouts) {
    for (const timeout of global.__activeTimeouts) {
      clearTimeout(timeout);
    }
    global.__activeTimeouts.clear();
  }
  
  // 7.2 Tüm aktif AbortController'ları abort et
  if (global.__activeControllers) {
    for (const controller of global.__activeControllers) {
      try {
        controller.abort();
      } catch (e) {
        // ignore
      }
    }
    global.__activeControllers.clear();
  }
  
  // 7.3 Kalan async işlemler için bekle
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // 7.4 GC çağır (--expose-gc ile çalıştırıldıysa)
  if (global.gc) {
    global.gc();
  }
  
  // 7.5 Console'ları geri yükle
  console.warn = originalWarn;
  console.error = originalError;
});

// ─── 8. React Native özel ayarları ───────────────────────────────────────────
// DevLauncher mock (React Native development)
global.EXDevLauncher = null;

// ─── 9. Fetch mock (opsiyonel) ───────────────────────────────────────────────
// Testlerde network istekleri için global fetch mock
if (!global.fetch) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({}),
    text: async () => '',
  }) as jest.Mock;
}
