/**
 * src/screens/TerminalScreen.tsx — Yeniden yazıldı
 *
 * Değişiklikler:
 *   • container?.config.autoRun null-safe guard
 *   • EventBus bağlantısı güvenli (container opsiyonel)
 *   • Toolbar: Çalıştır + Temizle + Durdur butonları aktif
 *   • Timestamp gösterimi (satır başında)
 *   • Platform güvenli autoRun erişimi
 */

import React, {
  memo,
  useCallback,
  useEffect,
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppContext } from '@/app/AppContext';

// ─── Tipler ───────────────────────────────────────────────────────────────────

export type LineKind = 'stdout' | 'stderr' | 'info' | 'success' | 'warn';

export interface TerminalLine {
  id:        string;
  kind:      LineKind;
  text:      string;
  timestamp: number;
}

const RING_CAPACITY = 1000;
let lineCounter = 0;

function makeLine(kind: LineKind, text: string): TerminalLine {
  return { id: `tl_${++lineCounter}`, kind, text, timestamp: Date.now() };
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

// ─── useTerminalRuntime ───────────────────────────────────────────────────────

function useTerminalRuntime({ container }: { container?: AppContainer }) {
  const ringRef    = useRef<TerminalLine[]>([]);
  const [lines, setLines]       = useState<TerminalLine[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const mountedRef = useRef(true);
  const abortRef   = useRef<AbortController | null>(null);

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

  const { services } = useAppContext();
  const eventBus = container?.eventBus ?? services.eventBus;

  // run/clear fonksiyonları önce tanımlayalım (useEffect'te kullanılıyor)
  const clear = useCallback(() => {
    ringRef.current = [];
    setLines([]);
    abortRef.current?.abort();
  }, []);

  const run = useCallback(async (entryFile?: string) => {
    if (isRunning) {
      abortRef.current?.abort();
    }
    abortRef.current = new AbortController();
    setIsRunning(true);
    pushLine('info', `▶ Çalıştırılıyor${entryFile ? `: ${entryFile}` : ''}…`);

    try {
      const { Bundler } = await import('../runtime/bundler/Bundler');
      const bundler = new Bundler('');
      const payload = {
        executionId: String(Date.now()) as import('../types/core').UUID,
        entryPath:   entryFile ?? 'index.js',
        files:       {} as Record<string, string>,
      };
      const result = await bundler.bundle(payload, abortRef.current.signal);
      if (!mountedRef.current) return;
      if (result.ok) {
        pushLine('success', `✓ Tamamlandı (${result.data?.sizeBytes ?? 0} bytes)`);
      } else {
        pushLine('warn', `✗ Hata: ${result.error.message}`);
      }
    } catch (e: unknown) {
      if (!mountedRef.current) return;
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== 'AbortError') pushLine('stderr', `✗ ${msg}`);
    } finally {
      if (mountedRef.current) setIsRunning(false);
    }
  }, [isRunning, pushLine]);

  useEffect(() => {
    const u1 = eventBus.on('terminal:run', ({ entryFile }: { entryFile?: string }) => {
      void run(entryFile);
    });
    const u2 = eventBus.on('terminal:clear', () => {
      clear();
    });
    const u3 = eventBus.on('file:saved', ({ file }: { file: { name: string } }) => {
      // null-safe autoRun erişimi
      const autoRun = (container as any)?.config?.autoRun ?? false;
      if (autoRun) {
        eventBus.emit('terminal:run', { entryFile: file.name });
      }
    });
    return () => { u1(); u2(); u3(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventBus]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    if (mountedRef.current) setIsRunning(false);
    pushLine('warn', '■ Durduruldu.');
  }, [pushLine]);

  return { lines, isRunning, run, clear, stop };
}

// ─── TerminalLineRow ──────────────────────────────────────────────────────────

const LINE_COLORS: Record<LineKind, string> = {
  stdout:  '#cdd6f4',
  stderr:  '#f38ba8',
  info:    '#89b4fa',
  success: '#a6e3a1',
  warn:    '#fab387',
};

const TerminalLineRow = memo(({ line }: { line: TerminalLine }) => (
  <Text style={[st.lineText, { color: LINE_COLORS[line.kind] }]} selectable>
    <Text style={st.timestamp}>{fmtTime(line.timestamp)} </Text>
    {line.text}
  </Text>
));
TerminalLineRow.displayName = 'TerminalLineRow';

// ─── TerminalScreen ───────────────────────────────────────────────────────────

export interface TerminalScreenProps {
  container?: AppContainer;
}

export function TerminalScreen({ container }: TerminalScreenProps): React.ReactElement {
  const { lines, isRunning, run, clear, stop } = useTerminalRuntime({ container });
  const { top } = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);

  const prevLenRef = useRef(0);
  useEffect(() => {
    if (lines.length !== prevLenRef.current) {
      prevLenRef.current = lines.length;
      scrollRef.current?.scrollToEnd({ animated: false });
    }
  }, [lines.length]);

  const handleRun   = useCallback(() => { void run(); },   [run]);
  const handleClear = useCallback(() => clear(), [clear]);
  const handleStop  = useCallback(() => stop(),  [stop]);

  return (
    <View style={st.root}>
      {/* Toolbar */}
      <View style={[st.toolbar, { paddingTop: top + 8 }]}>
        <View style={st.toolbarLeft}>
          <Text style={st.toolbarTitle}>⬛ Terminal</Text>
          <Text style={st.toolbarSub}>{lines.length} satır</Text>
        </View>
        <View style={st.toolbarActions}>
          {isRunning ? (
            <Pressable style={[st.btn, st.btnDanger]} onPress={handleStop}>
              <Text style={st.btnText}>■ Durdur</Text>
            </Pressable>
          ) : (
            <Pressable style={[st.btn, st.btnRun]} onPress={handleRun}>
              <Text style={[st.btnText, st.btnRunText]}>▶ Çalıştır</Text>
            </Pressable>
          )}
          <Pressable style={st.btn} onPress={handleClear}>
            <Text style={st.btnText}>✕ Temizle</Text>
          </Pressable>
        </View>
      </View>

      {/* Çıktı */}
      <ScrollView
        ref={scrollRef}
        style={st.output}
        contentContainerStyle={st.outputContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {lines.length === 0 ? (
          <View style={st.emptyWrap}>
            <Text style={st.emptyIcon}>⬛</Text>
            <Text style={st.emptyTitle}>Terminal Hazır</Text>
            <Text style={st.emptyDesc}>▶ Çalıştır'a basın veya bir dosya kaydedin.</Text>
          </View>
        ) : (
          lines.map(line => <TerminalLineRow key={line.id} line={line} />)
        )}
      </ScrollView>

      {/* Status bar */}
      <View style={st.statusBar}>
        {isRunning && <ActivityIndicator size="small" color="#a6e3a1" style={{ marginRight: 6 }} />}
        <Text style={st.statusText}>
          {isRunning ? 'Çalışıyor…' : `Kapasite: ${RING_CAPACITY} satır`}
        </Text>
      </View>
    </View>
  );
}

// ─── Stiller ─────────────────────────────────────────────────────────────────

const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

const st = StyleSheet.create({
  root:         { flex: 1, backgroundColor: '#11111b' },
  toolbar:      { flexDirection: 'row', alignItems: 'center',
                  paddingHorizontal: 12, paddingVertical: 8,
                  backgroundColor: '#1e1e2e',
                  borderBottomWidth: 1, borderBottomColor: '#313244' },
  toolbarLeft:  { flex: 1, gap: 2 },
  toolbarTitle: { fontSize: 12, fontWeight: '700', color: '#a6e3a1', fontFamily: MONO },
  toolbarSub:   { fontSize: 10, color: '#45475a', fontFamily: MONO },
  toolbarActions:{ flexDirection: 'row', gap: 6 },
  btn:          { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6,
                  backgroundColor: '#2a2a3e',
                  borderWidth: 1, borderColor: '#313244' },
  btnRun:       { borderColor: '#a6e3a1', backgroundColor: 'rgba(166,227,161,0.1)' },
  btnRunText:   { color: '#a6e3a1' },
  btnDanger:    { borderColor: '#f38ba8', backgroundColor: 'rgba(243,139,168,0.1)' },
  btnText:      { fontSize: 11, color: '#6c7086', fontFamily: MONO },
  output:       { flex: 1 },
  outputContent:{ padding: 12, gap: 2, minHeight: '100%' },
  lineText:     { fontSize: 11, fontFamily: MONO, lineHeight: 17 },
  timestamp:    { color: '#45475a', fontSize: 10 },
  emptyWrap:    { alignItems: 'center', paddingTop: 60, gap: 8 },
  emptyIcon:    { fontSize: 28 },
  emptyTitle:   { fontSize: 13, color: '#a6e3a1', fontFamily: MONO, fontWeight: '700' },
  emptyDesc:    { fontSize: 11, color: '#45475a', fontFamily: MONO },
  statusBar:    { flexDirection: 'row', alignItems: 'center',
                  paddingHorizontal: 12, paddingVertical: 4,
                  backgroundColor: '#1e1e2e',
                  borderTopWidth: 1, borderTopColor: '#313244' },
  statusText:   { fontSize: 10, color: '#45475a', fontFamily: MONO },
});
