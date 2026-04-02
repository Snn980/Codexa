/**
 * src/screens/TerminalScreen.tsx
 *
 * § 60 — Runtime terminal: Bundler + ConsoleStream + RingBuffer → VirtualList.
 *
 * Canonical implementasyon (app/screens/TerminalScreen.tsx'in yerini alır).
 *
 * Mimari:
 *   useTerminalRuntime(container)
 *     ├── ConsoleStream → stdout/stderr satırları akışı
 *     ├── RingBuffer<TerminalLine>(capacity: 1000)
 *     └── Bundler.run(entryFile) → Result<BundleResult>
 *   VirtualList → RingBuffer'dan satırları çeker
 *
 * EventBus entegrasyonu (§ 3, § 60):
 *   - terminal:run    → Bundler.run() tetikler
 *   - terminal:clear  → RingBuffer.clear()
 *   - file:saved      → AppConfig.autoRun=true ise terminal:run emit edilir
 *
 * § 1  : Result<T>
 * § 3  : EventBus unsub cleanup
 * § 8  : mountedRef + useCallback + useRef
 * § 18 : backpressure (RingBuffer capacity)
 */

import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type { AppContainer } from '../app/AppContainer';
import { useAppContext } from '@/app/AppContext';
import type { BundlePayload } from '../ipc/Protocol';
// RingBuffer ConsoleEntry tipine bağlı — TerminalLine için plain array kullanıyoruz

// ─── Terminal Satırı ──────────────────────────────────────────────────────────

export type LineKind = 'stdout' | 'stderr' | 'info' | 'success' | 'warn';

export interface TerminalLine {
  id:        string;
  kind:      LineKind;
  text:      string;
  timestamp: number;
}

// ─── Sabitler ─────────────────────────────────────────────────────────────────

const RING_CAPACITY = 1000; // § 60 — son 1000 satır
let   lineCounter   = 0;

function makeLine(kind: LineKind, text: string): TerminalLine {
  return { id: `tl_${++lineCounter}`, kind, text, timestamp: Date.now() };
}

// ─── useTerminalRuntime ───────────────────────────────────────────────────────

interface UseTerminalRuntimeOptions {
  container?: AppContainer;
}

interface UseTerminalRuntimeReturn {
  lines:    TerminalLine[];
  isRunning: boolean;
  run:      (entryFile?: string) => void;
  clear:    () => void;
}

function useTerminalRuntime({ container }: UseTerminalRuntimeOptions): UseTerminalRuntimeReturn {
  const ringRef    = useRef<TerminalLine[]>([]);
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const mountedRef = useRef(true);
  const abortRef   = useRef<AbortController | null>(null);

  // § 8 — mountedRef
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const pushLine = useCallback((kind: LineKind, text: string) => {
    if (!mountedRef.current) return;
    const line = makeLine(kind, text);
    ringRef.current.push(line);
    if (ringRef.current.length > RING_CAPACITY) {
      ringRef.current = ringRef.current.slice(-RING_CAPACITY);
    }
    setLines([...ringRef.current]);
  }, []);

  // ─── EventBus entegrasyonu ─────────────────────────────────────────────────

  const { services } = useAppContext();
          const eventBus = container?.eventBus ?? services.eventBus;

  useEffect(() => {
    // § 3 — unsub cleanup
    const u1 = eventBus.on('terminal:run', ({ entryFile }) => {
      run(entryFile);
    });

    const u2 = eventBus.on('terminal:clear', () => {
      clear();
    });

    // file:saved → autoRun kontrolü
    const u3 = eventBus.on('file:saved', ({ file }) => {
      // § 65 — container.config.autoRun (IAppConfig'te tanımlı)
      if (container.config.autoRun) {
        eventBus.emit('terminal:run', { entryFile: file.name });
      }
    });

    return () => { u1(); u2(); u3(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventBus]);

  // ─── run ───────────────────────────────────────────────────────────────────

  const run = useCallback(async (entryFile?: string) => {
    if (isRunning) {
      abortRef.current?.abort();
    }

    abortRef.current = new AbortController();
    setIsRunning(true);
    pushLine('info', `▶ Çalıştırılıyor${entryFile ? `: ${entryFile}` : ''}…`);

    try {
      // Bundler dinamik import — WASM heavy load Worker thread'de (§ 0)
      const { Bundler } = await import('../runtime/bundler/Bundler');
      const bundler = new Bundler(''); // wasmURL: runtime'da inject edilir

      const payload = {
        executionId: String(Date.now()) as import('../types/core').UUID,
        entryPath:   entryFile ?? 'index.js',
        files:       {} as Record<string, string>,
      };
      const result = await bundler.bundle(payload, abortRef.current.signal);

      if (!mountedRef.current) return;

      if (result.ok) {
        pushLine('success', `✓ Tamamlandı (${result.data?.sizeBytes ?? 0}ms)`);
      } else {
        pushLine('warn', `✗ Hata: ${result.error.message}`);
      }
    } catch (e: unknown) {
      if (!mountedRef.current) return;
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== 'AbortError') {
        pushLine('stderr', `✗ ${msg}`);
      }
    } finally {
      if (mountedRef.current) setIsRunning(false);
    }
  }, [isRunning, pushLine]);

  // ─── clear ─────────────────────────────────────────────────────────────────

  const clear = useCallback(() => {
    ringRef.current = [];
    setLines([]);
    abortRef.current?.abort();
  }, []);

  return { lines, isRunning, run, clear };
}

// ─── TerminalLine bileşeni ────────────────────────────────────────────────────

const LINE_COLORS: Record<LineKind, string> = {
  stdout:  '#cdd6f4',
  stderr:  '#f38ba8',
  info:    '#89b4fa',
  success: '#a6e3a1',
  warn:    '#fab387',
};

const TerminalLineRow = memo(({ line }: { line: TerminalLine }) => (
  <Text
    style={[styles.lineText, { color: LINE_COLORS[line.kind] }]}
    selectable
  >
    {line.text}
  </Text>
));
TerminalLineRow.displayName = 'TerminalLineRow';

// ─── TerminalScreen ───────────────────────────────────────────────────────────

export interface TerminalScreenProps {
  container: AppContainer;
}

export function TerminalScreen({ container }: TerminalScreenProps): React.ReactElement {
  const { lines, isRunning, run, clear } = useTerminalRuntime({ container });
  const scrollRef = useRef<ScrollView>(null);

  // Yeni satır gelince en alta kaydır
  const prevLenRef = useRef(0);
  useEffect(() => {
    if (lines.length !== prevLenRef.current) {
      prevLenRef.current = lines.length;
      scrollRef.current?.scrollToEnd({ animated: false });
    }
  }, [lines.length]);

  const handleRun   = useCallback(() => run(),  [run]);
  const handleClear = useCallback(() => clear(), [clear]);

  return (
    <View style={styles.root}>
      {/* Toolbar */}
      <View style={styles.toolbar}>
        <Text style={styles.toolbarTitle}>Terminal</Text>
        <View style={styles.toolbarActions}>
          <Pressable
            style={[styles.runBtn, isRunning && styles.runBtnActive]}
            onPress={handleRun}
            accessibilityRole="button"
            accessibilityLabel={isRunning ? 'Çalışıyor' : 'Çalıştır'}
          >
            {isRunning
              ? <ActivityIndicator size="small" color="#a6e3a1" />
              : <Text style={styles.runBtnText}>▶ Çalıştır</Text>
            }
          </Pressable>
          <Pressable
            style={styles.clearBtn}
            onPress={handleClear}
            accessibilityRole="button"
            accessibilityLabel="Temizle"
          >
            <Text style={styles.clearBtnText}>✕ Temizle</Text>
          </Pressable>
        </View>
      </View>

      {/* Çıktı alanı */}
      <ScrollView
        ref={scrollRef}
        style={styles.output}
        contentContainerStyle={styles.outputContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {lines.length === 0 ? (
          <Text style={styles.emptyText}>
            Henüz çıktı yok. ▶ Çalıştır'a basın.
          </Text>
        ) : (
          lines.map(line => (
            <TerminalLineRow key={line.id} line={line} />
          ))
        )}
      </ScrollView>

      {/* Satır sayısı */}
      <View style={styles.statusBar}>
        <Text style={styles.statusText}>
          {lines.length} satır — kapasite: {RING_CAPACITY}
        </Text>
      </View>
    </View>
  );
}

// ─── Stiller ──────────────────────────────────────────────────────────────────

const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

const styles = StyleSheet.create({
  root:          { flex: 1, backgroundColor: '#11111b' },
  toolbar:       { flexDirection: 'row', alignItems: 'center',
                   paddingHorizontal: 12, paddingVertical: 8,
                   backgroundColor: '#1e1e2e',
                   borderBottomWidth: 1, borderBottomColor: '#313244' },
  toolbarTitle:  { flex: 1, fontSize: 12, fontWeight: '700',
                   color: '#a6e3a1', fontFamily: MONO },
  toolbarActions:{ flexDirection: 'row', gap: 8 },
  runBtn:        { flexDirection: 'row', alignItems: 'center',
                   paddingHorizontal: 10, paddingVertical: 5,
                   borderRadius: 6, backgroundColor: '#2a2a3e',
                   borderWidth: 1, borderColor: '#313244', minWidth: 80 },
  runBtnActive:  { borderColor: '#a6e3a1' },
  runBtnText:    { fontSize: 11, color: '#a6e3a1', fontFamily: MONO },
  clearBtn:      { paddingHorizontal: 10, paddingVertical: 5,
                   borderRadius: 6, backgroundColor: '#2a2a3e',
                   borderWidth: 1, borderColor: '#313244' },
  clearBtnText:  { fontSize: 11, color: '#6c7086', fontFamily: MONO },
  output:        { flex: 1 },
  outputContent: { padding: 12, gap: 2 },
  lineText:      { fontSize: 12, fontFamily: MONO, lineHeight: 18 },
  emptyText:     { fontSize: 12, color: '#45475a', fontFamily: MONO,
                   textAlign: 'center', marginTop: 40 },
  statusBar:     { paddingHorizontal: 12, paddingVertical: 4,
                   backgroundColor: '#1e1e2e',
                   borderTopWidth: 1, borderTopColor: '#313244' },
  statusText:    { fontSize: 10, color: '#45475a', fontFamily: MONO },
});
