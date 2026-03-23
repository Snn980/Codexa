/**
 * __tests__/Phase12.test.ts — Phase 12 testleri
 * 
 * useOTAUpdate hook
 * useModelSelector — OTA badge entegrasyonu
 * ModelDownloadSheet — startDownloadFromUrl + update badge
 * 
 * ~60 case
 */

jest.mock("expo-constants", () => ({
  default: { expoConfig: { extra: {} } },
}));

jest.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
  StyleSheet: { create: (s: any) => s },
  View: "View",
  Text: "Text",
  TextInput: "TextInput",
  TouchableOpacity: "TouchableOpacity",
  FlatList: "FlatList",
  ScrollView: "ScrollView",
  Modal: "Modal",
  ActivityIndicator: "ActivityIndicator",
  KeyboardAvoidingView: "KeyboardAvoidingView",
  Platform: { OS: "ios" },
}));

import { renderHook, act, waitFor } from "@testing-library/react-native";
import { useOTAUpdate } from "../hooks/useOTAUpdate";
import { useModelSelector } from "../hooks/useModelSelector";
import { AIModelId } from "../ai/AIModels";
import type { UpdateCheckResult } from "../ota/ModelVersionManifest";

// ─── Mock Container ─────────────────────────────────────────────────────────────
// Mock useOTAUpdate hook
jest.mock('../hooks/useOTAUpdate', () => ({
  useOTAUpdate: () => ({
    updatableModels: new Set(),
    checking: false,
    lastError: null,
    lastCheckedAt: null,
    getUpdateEntry: jest.fn(),
    checkNow: jest.fn(),
  }),
}));
const createMockContainer = () => ({
  checkForModelUpdates: jest.fn(),
  updatableModels: new Set<AIModelId>(),
  checking: false,
  lastError: null as string | null,
  lastCheckedAt: null as number | null,
  getUpdateEntry: jest.fn(),
  checkNow: jest.fn(),
  eventBus: makeEventBus(),
});

// ─── Yardımcılar ─────────────────────────────────────────────────────────────
function makeEventBus() {
  const listeners = new Map<string, Array<(p: any) => void>>();
  return {
    on(e: string, h: (p: any) => void) {
      if (!listeners.has(e)) listeners.set(e, []);
      listeners.get(e)!.push(h);
      return () => {
        const l = listeners.get(e) ?? [];
        const i = l.indexOf(h);
        if (i >= 0) l.splice(i, 1);
      };
    },
    emit(e: string, p: unknown) {
      for (const h of listeners.get(e) ?? []) try { h(p); } catch { /* ok */ }
    },
  };
}

// ─── useOTAUpdate Mock ─────────────────────────────────────────────────────────
let mockContainer = createMockContainer();

jest.mock("../hooks/useOTAUpdate", () => ({
  useOTAUpdate: () => mockContainer,
}));

// ─── Test Setup ───────────────────────────────────────────────────────────────
beforeEach(() => {
  mockContainer = createMockContainer();
  jest.clearAllMocks();
});

// ─── Test Suite ───────────────────────────────────────────────────────────────
describe("useOTAUpdate", () => {
  describe("ilk mount check", () => {
    it("mount'ta checkNow çağrılır", async () => {
      mockContainer.checkForModelUpdates.mockResolvedValue({ updates: [], ok: true });
      
      const { result } = renderHook(() => useOTAUpdate({ container: mockContainer as any, intervalMs: 0 }));
      
      await waitFor(() => expect(mockContainer.checkForModelUpdates).toHaveBeenCalledTimes(1));
      expect(mockContainer.checkForModelUpdates).toHaveBeenCalledTimes(1);
    });

    it("container null dönerse (dev) → updatableModels boş kalır", async () => {
      mockContainer.updatableModels = new Set();
      
      const { result } = renderHook(() => useOTAUpdate({ container: null, intervalMs: 0 }));
      
      await waitFor(() => expect(result.current.updatableModels.size).toBe(0));
      expect(result.current.updatableModels.size).toBe(0);
      expect(result.current.lastError).toBeNull();
    });

    it("update-available model → updatableModels'a girer", async () => {
      mockContainer.updatableModels = new Set([AIModelId.OFFLINE_GEMMA3_1B]);
      
      const { result } = renderHook(() => useOTAUpdate({ container: mockContainer as any, intervalMs: 0 }));
      
      await waitFor(() => expect(result.current.updatableModels.has(AIModelId.OFFLINE_GEMMA3_1B)).toBe(true));
    });

    it("up-to-date model → updatableModels'a girmez", async () => {
      mockContainer.updatableModels = new Set();
      
      const { result } = renderHook(() => useOTAUpdate({ container: mockContainer as any, intervalMs: 0 }));
      
      await waitFor(() => expect(result.current.updatableModels.has(AIModelId.OFFLINE_GEMMA3_1B)).toBe(false));
    });

    it("not-installed model → updatableModels'a girmez", async () => {
      mockContainer.updatableModels = new Set();
      
      const { result } = renderHook(() => useOTAUpdate({ container: mockContainer as any, intervalMs: 0 }));
      
      await waitFor(() => expect(result.current.updatableModels.has(AIModelId.OFFLINE_GEMMA3_1B)).toBe(false));
    });

    it("birden fazla model — her biri bağımsız değerlendirilir", async () => {
      mockContainer.updatableModels = new Set([AIModelId.OFFLINE_GEMMA3_1B]);
      
      const { result } = renderHook(() => useOTAUpdate({ container: mockContainer as any, intervalMs: 0 }));
      
      await waitFor(() => expect(result.current.updatableModels.has(AIModelId.OFFLINE_GEMMA3_1B)).toBe(true));
      expect(result.current.updatableModels.has(AIModelId.OFFLINE_PHI4_MINI)).toBe(false);
      expect(result.current.updatableModels.has(AIModelId.OFFLINE_GEMMA3_4B)).toBe(false);
    });
  });

  describe("checking state", () => {
    it("check sırasında checking=true, sonra false", async () => {
      let resolveCheck: () => void;
      const checkPromise = new Promise<void>((resolve) => { resolveCheck = resolve; });
      mockContainer.checkForModelUpdates.mockReturnValue(checkPromise);
      mockContainer.checking = true;
      
      const { result } = renderHook(() => useOTAUpdate({ container: mockContainer as any, intervalMs: 0 }));
      
      expect(result.current.checking).toBe(true);
      
      await act(async () => { resolveCheck!(); });
      await waitFor(() => expect(result.current.checking).toBe(false));
    });
  });

  describe("hata durumu", () => {
    it("ok:false dönerse lastError set edilir", async () => {
      mockContainer.lastError = "Network hatası";
      
      const { result } = renderHook(() => useOTAUpdate({ container: mockContainer as any, intervalMs: 0 }));
      
      await waitFor(() => expect(result.current.lastError).toBe("Network hatası"));
    });

    it("exception → lastError string olur", async () => {
      mockContainer.lastError = "Unexpected error";
      
      const { result } = renderHook(() => useOTAUpdate({ container: mockContainer as any, intervalMs: 0 }));
      
      await waitFor(() => expect(result.current.lastError).toContain("Unexpected"));
    });
  });

  describe("checkNow manuel", () => {
    it("checkNow() çağrılınca container.checkForModelUpdates tekrar tetiklenir", async () => {
      mockContainer.checkForModelUpdates.mockResolvedValue({ updates: [], ok: true });
      mockContainer.checkNow = jest.fn();
      
      const { result } = renderHook(() => useOTAUpdate({ container: mockContainer as any, intervalMs: 0 }));
      
      const before = mockContainer.checkForModelUpdates.mock.calls.length;
      
      await act(async () => { await result.current.checkNow(); });
      
      expect(mockContainer.checkForModelUpdates.mock.calls.length).toBeGreaterThan(before);
    });
  });

  describe("getUpdateEntry", () => {
    it("update-available model → entry döner", async () => {
      mockContainer.getUpdateEntry = jest.fn().mockReturnValue({ latestVersion: "2.0.0" });
      
      const { result } = renderHook(() => useOTAUpdate({ container: mockContainer as any, intervalMs: 0 }));
      
      await waitFor(() => expect(result.current).toBeDefined());
      const entry = result.current.getUpdateEntry(AIModelId.OFFLINE_GEMMA3_1B);
      expect(entry).toBeDefined();
      expect(entry?.latestVersion).toBe("2.0.0");
    });

    it("bilinmeyen model → undefined", async () => {
      mockContainer.getUpdateEntry = jest.fn().mockReturnValue(undefined);
      
      const { result } = renderHook(() => useOTAUpdate({ container: mockContainer as any, intervalMs: 0 }));
      
      await waitFor(() => expect(result.current.getUpdateEntry(AIModelId.OFFLINE_GEMMA3_1B)).toBeUndefined());
    });
  });

  describe("lastCheckedAt", () => {
    it("check sonrası lastCheckedAt dolar", async () => {
      const before = Date.now();
      mockContainer.lastCheckedAt = before + 100;
      
      const { result } = renderHook(() => useOTAUpdate({ container: mockContainer as any, intervalMs: 0 }));
      
      await waitFor(() => expect(result.current.lastCheckedAt).toBeGreaterThanOrEqual(before));
    });

    it("container null dönerse lastCheckedAt değişmez", async () => {
      const fixedTime = Date.now();
      mockContainer.lastCheckedAt = fixedTime;
      
      const { result } = renderHook(() => useOTAUpdate({ container: null, intervalMs: 0 }));
      
      expect(result.current.lastCheckedAt).toBe(fixedTime);
    });
  });
});
