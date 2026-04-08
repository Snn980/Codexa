/**
 * @file     index.ts
 * @module   libtermexec
 * @version  1.0.0
 *
 * @description
 *   libtermexec JS katmanı — Native HybridObject wrapper + React hook.
 *
 *   Kullanım:
 *     import { TermExecModule, useTermExec } from 'libtermexec';
 *
 *   TermExecModule → singleton, doğrudan native erişim
 *   useTermExec    → React hook, session lifecycle + EventBus entegrasyonu
 *
 *   Tasarım kararları:
 *   • Singleton: HybridObject her createHybridObject çağrısında yeni native instance
 *     oluşturur — tek callback kaydı yeterli, birden fazla oluşturmaya gerek yok.
 *   • Batching: onData çok sık gelir; 16ms (1 frame) batching ile RN re-render
 *     baskısı azaltılır.
 *   • Platform guard: iOS'ta createSession NotImplemented fırlatır — UI bunu yakalar.
 */

import { NitroModules } from 'react-native-nitro-modules';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import type { TermExec, SessionConfig } from '../nitrogen/specs/TermExec.nitro';

// ─── Singleton ────────────────────────────────────────────────────────────────

let _instance: TermExec | null = null;

function getInstance(): TermExec {
  if (!_instance) {
    _instance = NitroModules.createHybridObject<TermExec>('TermExec');
  }
  return _instance;
}

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

function getDefaultConfig(overrides?: Partial<SessionConfig>): SessionConfig {
  return {
    shellPath: '/system/bin/sh',
    args:      ['-l'],
    env:       {},
    cwd:       '/data/data/com.codexa.app/files',
    cols:      80,
    rows:      24,
    ...overrides,
  };
}

// ─── useTermExec hook ─────────────────────────────────────────────────────────

export interface TerminalLine {
  id:        string;
  text:      string;
  kind:      'stdout' | 'stderr' | 'info' | 'error';
  timestamp: number;
}

interface UseTermExecOptions {
  config?:       Partial<SessionConfig>;
  ringCapacity?: number;   // max satır — default 1000
  batchMs?:      number;   // render batching — default 16ms
}

interface UseTermExecResult {
  lines:       TerminalLine[];
  isRunning:   boolean;
  sessionId:   string | null;
  isSupported: boolean;
  start:       () => void;
  stop:        () => void;
  sendInput:   (text: string) => void;
  resize:      (cols: number, rows: number) => void;
  clear:       () => void;
}

let _lineId = 0;
const uid = () => `tl_${++_lineId}`;

export function useTermExec(opts: UseTermExecOptions = {}): UseTermExecResult {
  const {
    config,
    ringCapacity = 1000,
    batchMs      = 16,
  } = opts;

  const isSupported = Platform.OS === 'android'; // iOS Phase 2

  const [lines,     setLines]     = useState<TerminalLine[]>([]);
  const [isRunning, setRunning]   = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const ringRef    = useRef<TerminalLine[]>([]);
  const pendingRef = useRef<TerminalLine[]>([]);
  const timerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sidRef     = useRef<string | null>(null);

  // Batch flush
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

  // Native callback'leri kaydet
  useEffect(() => {
    if (!isSupported) return;

    TermExecModule.onData((sid, data) => {
      if (sid !== sidRef.current) return;
      pushLine(data, 'stdout');
    });

    TermExecModule.onExit((sid, exitCode) => {
      if (sid !== sidRef.current) return;
      pushLine(`\r\n[Process exited with code ${exitCode}]`, 'info');
      setRunning(false);
      setSessionId(null);
      sidRef.current = null;
    });

    TermExecModule.onError((sid, error) => {
      if (sid !== sidRef.current) return;
      pushLine(`[Error: ${error}]`, 'error');
      setRunning(false);
      setSessionId(null);
      sidRef.current = null;
    });

    return () => {
      // Cleanup: callback'leri temizle
      getInstance().onSessionData  = null;
      getInstance().onSessionExit  = null;
      getInstance().onSessionError = null;
    };
  }, [isSupported, pushLine]);

  // Session cleanup on unmount
  useEffect(() => {
    return () => {
      if (sidRef.current) {
        TermExecModule.closeSession(sidRef.current);
      }
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const start = useCallback(() => {
    if (!isSupported) {
      pushLine('[Terminal: iOS desteği Phase 2\'de eklenecek]', 'info');
      return;
    }
    if (sidRef.current) {
      TermExecModule.closeSession(sidRef.current);
    }

    try {
      const sid = TermExecModule.createSession(getDefaultConfig(config));
      sidRef.current = sid;
      setSessionId(sid);
      setRunning(true);
      pushLine('Session başlatıldı.', 'info');
    } catch (e) {
      pushLine(`[Start error: ${e}]`, 'error');
    }
  }, [isSupported, config, pushLine]);

  const stop = useCallback(() => {
    if (sidRef.current) {
      TermExecModule.closeSession(sidRef.current);
      pushLine('\r\n[Durduruldu]', 'info');
    }
  }, [pushLine]);

  const sendInput = useCallback((text: string) => {
    if (sidRef.current) {
      TermExecModule.writeInput(sidRef.current, text);
    }
  }, []);

  const resize = useCallback((cols: number, rows: number) => {
    if (sidRef.current) {
      TermExecModule.resizeTerminal(sidRef.current, cols, rows);
    }
  }, []);

  const clear = useCallback(() => {
    ringRef.current    = [];
    pendingRef.current = [];
    setLines([]);
  }, []);

  return { lines, isRunning, sessionId, isSupported, start, stop, sendInput, resize, clear };
}

// Re-export types
export type { SessionConfig, TermExec };
