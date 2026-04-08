/**
 * index.ts — libtermexec JS katmanı
 *
 * Expo Go uyumluluğu:
 *   NitroModules.createHybridObject başarısız olursa (Expo Go'da olur)
 *   → expoGoMock devreye girer, uyarı verir
 *   → Gerçek terminal için expo-dev-client kullanılmalı
 *
 * Termux desteği:
 *   shellPath boş bırakılırsa → native taraf otomatik Termux tespit eder
 *   config.shellPath = '' → /data/data/com.termux/files/usr/bin/bash
 */

import { NitroModules } from 'react-native-nitro-modules';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import type { TermExec, SessionConfig } from '../nitrogen/specs/TermExec.nitro';

// ─── Expo Go mock ─────────────────────────────────────────────────────────────

const EXPO_GO_WARNING = [
  '⚠️  Expo Go native modülleri desteklemez.',
  '   Terminal çalışmıyor — expo-dev-client kullanın:',
  '   npx expo install expo-dev-client',
  '   eas build --profile development',
].join('\n');

const expoGoMock: TermExec = {
  createSession:   () => { console.warn(EXPO_GO_WARNING); return 'mock-session'; },
  writeInput:      () => {},
  resizeTerminal:  () => {},
  killSession:     () => {},
  closeSession:    () => {},
  listSessions:    () => [],
  onSessionData:   null,
  onSessionExit:   null,
  onSessionError:  null,
} as unknown as TermExec;

// ─── Singleton ────────────────────────────────────────────────────────────────

let _instance: TermExec | null = null;
let _isExpoGo = false;

function getInstance(): TermExec {
  if (!_instance) {
    try {
      _instance = NitroModules.createHybridObject<TermExec>('TermExec');
    } catch {
      console.warn(EXPO_GO_WARNING);
      _instance = expoGoMock;
      _isExpoGo = true;
    }
  }
  return _instance;
}

export const isExpoGo = () => _isExpoGo;

// ─── TermExecModule ───────────────────────────────────────────────────────────

export const TermExecModule = {
  createSession(config: SessionConfig): string {
    return getInstance().createSession(config);
  },
  writeInput(sessionId: string, data: string): void {
    getInstance().writeInput(sessionId, data);
  },
  resizeTerminal(sessionId: string, cols: number, rows: number): void {
    getInstance().resizeTerminal(sessionId, cols, rows);
  },
  killSession(sessionId: string, signal = 9): void {
    getInstance().killSession(sessionId, signal);
  },
  closeSession(sessionId: string): void {
    getInstance().closeSession(sessionId);
  },
  listSessions(): string[] {
    return getInstance().listSessions();
  },
  onData(cb: (sessionId: string, data: string) => void): void {
    getInstance().onSessionData = cb;
  },
  onExit(cb: (sessionId: string, exitCode: number) => void): void {
    getInstance().onSessionExit = cb;
  },
  onError(cb: (sessionId: string, error: string) => void): void {
    getInstance().onSessionError = cb;
  },
} as const;

// ─── Default session config ───────────────────────────────────────────────────
// shellPath boş → native Termux tespiti yapar

function getDefaultConfig(overrides?: Partial<SessionConfig>): SessionConfig {
  return {
    shellPath: '',          // → native: Termux bash veya /system/bin/sh
    args:      ['-l'],
    env:       {},
    cwd:       '',          // → native: Termux HOME veya app files
    cols:      80,
    rows:      24,
    ...overrides,
  };
}

// ─── useTermExec hook ─────────────────────────────────────────────────────────

export interface TerminalLine {
  id:        string;
  text:      string;
  kind:      'stdout' | 'stderr' | 'info' | 'error' | 'warn';
  timestamp: number;
}

interface UseTermExecOptions {
  config?:       Partial<SessionConfig>;
  ringCapacity?: number;
  batchMs?:      number;
}

interface UseTermExecResult {
  lines:       TerminalLine[];
  isRunning:   boolean;
  sessionId:   string | null;
  isSupported: boolean;
  isExpoGo:    boolean;
  start:       () => void;
  stop:        () => void;
  sendInput:   (text: string) => void;
  resize:      (cols: number, rows: number) => void;
  clear:       () => void;
}

let _lineId = 0;
const uid = () => `tl_${++_lineId}`;

export function useTermExec(opts: UseTermExecOptions = {}): UseTermExecResult {
  const { config, ringCapacity = 1000, batchMs = 16 } = opts;

  // iOS → wasm3 Phase 2, Android → Termux/PTY
  // Expo Go'da her ikisi de mock
  const isSupported = Platform.OS === 'android' || Platform.OS === 'ios';
  const isGo = isExpoGo();

  const [lines,     setLines]     = useState<TerminalLine[]>([]);
  const [isRunning, setRunning]   = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const ringRef    = useRef<TerminalLine[]>([]);
  const pendingRef = useRef<TerminalLine[]>([]);
  const timerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sidRef     = useRef<string | null>(null);

  const flush = useCallback(() => {
    if (pendingRef.current.length === 0) return;
    ringRef.current = [...ringRef.current, ...pendingRef.current];
    if (ringRef.current.length > ringCapacity) {
      ringRef.current = ringRef.current.slice(-ringCapacity);
    }
    setLines([...ringRef.current]);
    pendingRef.current = [];
    timerRef.current   = null;
  }, [ringCapacity]);

  const pushLine = useCallback((text: string, kind: TerminalLine['kind']) => {
    pendingRef.current.push({ id: uid(), text, kind, timestamp: Date.now() });
    if (!timerRef.current) {
      timerRef.current = setTimeout(flush, batchMs);
    }
  }, [flush, batchMs]);

  useEffect(() => {
    if (!isSupported) return;

    TermExecModule.onData((sid, data) => {
      if (sid !== sidRef.current) return;
      pushLine(data, 'stdout');
    });
    TermExecModule.onExit((sid, code) => {
      if (sid !== sidRef.current) return;
      pushLine(`\r\n[Process exited: ${code}]`, 'info');
      setRunning(false); setSessionId(null); sidRef.current = null;
    });
    TermExecModule.onError((sid, err) => {
      if (sid !== sidRef.current) return;
      pushLine(`[Error: ${err}]`, 'error');
      setRunning(false); setSessionId(null); sidRef.current = null;
    });

    return () => {
      getInstance().onSessionData  = null;
      getInstance().onSessionExit  = null;
      getInstance().onSessionError = null;
    };
  }, [isSupported, pushLine]);

  useEffect(() => {
    return () => {
      if (sidRef.current) TermExecModule.closeSession(sidRef.current);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const start = useCallback(() => {
    if (isGo) {
      pushLine(EXPO_GO_WARNING, 'warn');
      return;
    }
    if (sidRef.current) TermExecModule.closeSession(sidRef.current);
    try {
      const sid = TermExecModule.createSession(getDefaultConfig(config));
      sidRef.current = sid;
      setSessionId(sid); setRunning(true);
      pushLine('● Session başlatıldı', 'info');
    } catch (e) {
      pushLine(`[Start error: ${e}]`, 'error');
    }
  }, [isGo, config, pushLine]);

  const stop = useCallback(() => {
    if (sidRef.current) {
      TermExecModule.closeSession(sidRef.current);
      pushLine('\r\n[Durduruldu]', 'info');
    }
  }, [pushLine]);

  const sendInput  = useCallback((t: string) => {
    if (sidRef.current) TermExecModule.writeInput(sidRef.current, t);
  }, []);

  const resize = useCallback((c: number, r: number) => {
    if (sidRef.current) TermExecModule.resizeTerminal(sidRef.current, c, r);
  }, []);

  const clear = useCallback(() => {
    ringRef.current = []; pendingRef.current = []; setLines([]);
  }, []);

  return { lines, isRunning, sessionId, isSupported, isExpoGo: isGo,
           start, stop, sendInput, resize, clear };
}

export type { SessionConfig, TermExec };
