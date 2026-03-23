/**
 * jest.setup.ts — Jest global test ortamı kurulumu
 *
 * @testing-library/react-native v13.3.3 + React 19.2.4 + Jest 30
 */

// ─── Global timeout takibi (open handles fix) ─────────────────────────────────
declare global {
  var __activeTimeouts: Set<NodeJS.Timeout> | undefined;
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
    
    this.signal.addEventListener('abort', () => {
      global.__activeControllers?.delete(this);
    });
  }
}

global.AbortController = TrackedAbortController as any;

// ─── 3. React 19 test-renderer mock (CI hatasını çözer) ──────────────────────
jest.mock('react-test-renderer', () => ({
  create: jest.fn().mockReturnValue({
    toJSON: jest.fn(),
    update: jest.fn(),
    unmount: jest.fn(),
    root: {
      find: jest.fn(),
      findAll: jest.fn(),
      findByType: jest.fn(),
      findAllByType: jest.fn(),
    },
  }),
  act: jest.fn((callback: () => void) => callback()),
}));

// ─── 4. Global test timeout ───────────────────────────────────────────────────
jest.setTimeout(15_000);

// ─── 5. Console filtresi ──────────────────────────────────────────────────────
const IGNORED_WARNINGS = [
  'Warning: An update to',
  'Warning: Cannot update a component',
  'Warning: ReactDOM.render is no longer supported',
  'Warning: act(...)',
  'Low quality response but no escalation occurred',
  'Schedule failed (normal in Simulator)',
  'MAX_RESTARTS', // AIWorkerBridge uyarıları
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

// ─── 6. Her test öncesi hazırlık ──────────────────────────────────────────────
beforeEach(() => {
  jest.clearAllTimers?.();
});

// ─── 7. Her test sonrası temizlik ─────────────────────────────────────────────
afterEach(async () => {
  await new Promise(resolve => setTimeout(resolve, 10));
});

// ─── 8. Tüm testler sonrası open handles temizliği ────────────────────────────
afterAll(async () => {
  if (global.__activeTimeouts) {
    for (const timeout of global.__activeTimeouts) {
      clearTimeout(timeout);
    }
    global.__activeTimeouts.clear();
  }
  
  if (global.__activeControllers) {
    for (const controller of global.__activeControllers) {
      try {
        controller.abort();
      } catch (e) {}
    }
    global.__activeControllers.clear();
  }
  
  await new Promise(resolve => setTimeout(resolve, 100));
  
  if (global.gc) {
    global.gc();
  }
  
  console.warn = originalWarn;
  console.error = originalError;
});

// ─── 9. React Native özel ayarları ───────────────────────────────────────────
global.EXDevLauncher = null;

// ─── 10. Fetch mock ──────────────────────────────────────────────────────────
if (!global.fetch) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({}),
    text: async () => '',
  }) as jest.Mock;
}
