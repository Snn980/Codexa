/**
 * src/screens/TerminalScreen.tsx — Tema güncellemesi
 *
 * Değişiklikler:
 *   • useTheme() entegrasyonu — colors.terminal paleti kullanılır
 *   • LINE_COLORS artık sabit değil; colors.terminal'den alınır
 *   • makeStyles(colors) pattern
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
import { useAppContext }      from '@/app/AppContext';
import { useTheme }          from '@/theme';
import type { ThemeColors }  from '@/theme';

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

const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

// ─── Stil fabrikası ───────────────────────────────────────────────────────────

function makeStyles(C: ThemeColors) {
  const T = C.terminal;
  return {
    root:          { flex: 1, backgroundColor: T.bg },
    toolbar:       { flexDirection: 'row' as const, alignItems: 'center' as const, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: C.surface, borderBottomWidth: 1, borderBottomColor: C.border },
    toolbarLeft:   { flex: 1, gap: 2 },
    toolbarTitle:  { fontSize: 12, fontWeight: '700' as const, color: T.success, fontFamily: MONO },
    toolbarSub:    { fontSize: 10, color: C.muted, fontFamily: MONO },
    toolbarActions:{ flexDirection: 'row' as const, gap: 6 },
    btn:           { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, backgroundColor: C.surface2, borderWidth: 1, borderColor: C.border },
    btnRun:        { borderColor: T.success, backgroundColor: `${T.success}18` },
    btnRunText:    { color: T.success },
    btnDanger:     { borderColor: T.stderr, backgroundColor: `${T.stderr}18` },
    btnText:       { fontSize: 11, color: C.muted, fontFamily: MONO },
    output:        { flex: 1, backgroundColor: T.bg },
    outputContent: { padding: 12, gap: 2, minHeight: '100%' as any },
    lineText:      { fontSize: 11, fontFamily: MONO, lineHeight: 17 },
    timestamp:     { color: C.muted, fontSize: 10 },
    emptyWrap:     { alignItems: 'center' as const, paddingTop: 60, gap: 8 },
    emptyIcon:     { fontSize: 28 },
    emptyTitle:    { fontSize: 13, color: T.success, fontFamily: MONO, fontWeight: '700' as const },
    emptyDesc:     { fontSize: 11, color: C.muted, fontFamily: MONO },
    statusBar:     { flexDirection: 'row' as const, alignItems: 'center' as const, paddingHorizontal: 12, paddingVertical: 4, backgroundColor: C.surface, borderTopWidth: 1, borderTopColor: C.border },
    statusText:    { fontSize: 10, color: C.muted, fontFamily: MONO },
    lineColors:    {
      stdout:  T.stdout,
      stderr:  T.stderr,
      info:    T.info,
      success: T.success,
      warn:    T.warn,
    } as Record<LineKind, string>,
  };
}

// ─── useTerminalRuntime ───────────────────────────────────────────────────────

function useTerminalRuntime({ container }: { container?: AppContainer }) {
  const ringRef              = useRef<TerminalLine[]>([]);
  const [lines, setLines]    = useState<TerminalLine[]>([]);
  const [isRunning, setRunning] = useState(false);
  const mountedRef           = useRef(true);
  const abortRef             = useRef<AbortController | null>(null);

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

  const clear = useCallback(() => {
    ringRef.current = [];
    setLines([]);
    abortRef.current?.abort();
  }, []);

  const run = useCallback(async (entryFile?: string) => {
    if (isRunning) { abortRef.current?.abort(); }
    abortRef.current = new AbortController();
    setRunning(true);
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
        pushLine('success', `✓ Tamamlandı (${(result.data as any)?.sizeBytes ?? 0} bytes)`);
      } else {
        pushLine('warn', `✗ Hata: ${result.error.message}`);
      }
    } catch (e: unknown) {
      if (!mountedRef.current) return;
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== 'AbortError') pushLine('stderr', `✗ ${msg}`);
    } finally {
      if (mountedRef.current) setRunning(false);
    }
  }, [isRunning, pushLine]);

  useEffect(() => {
    const u1 = eventBus.on('terminal:run', ({ entryFile }: { entryFile?: string }) => {
      void run(entryFile);
    });
    const u2 = eventBus.on('terminal:clear', () => { clear(); });
    const u3 = eventBus.on('file:saved', ({ file }: { file: { name: string } }) => {
      const autoRun = (container as any)?.config?.autoRun ?? false;
      if (autoRun) { eventBus.emit('terminal:run', { entryFile: file.name }); }
    });
    return () => { u1(); u2(); u3(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventBus]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    if (mountedRef.current) setRunning(false);
    pushLine('warn', '■ Durduruldu.');
  }, [pushLine]);

  return { lines, isRunning, run, clear, stop };
}

// ─── TerminalLineRow ──────────────────────────────────────────────────────────

const TerminalLineRow = memo(({
  line, lineColors, lineTextStyle, timestampStyle,
}: {
  line: TerminalLine;
  lineColors: Record<LineKind, string>;
  lineTextStyle: object;
  timestampStyle: object;
}) => (
  <Text style={[lineTextStyle, { color: lineColors[line.kind] }]} selectable>
    <Text style={timestampStyle}>{fmtTime(line.timestamp)} </Text>
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
  const { top }    = useSafeAreaInsets();
  const { colors } = useTheme();
  const S          = React.useMemo(() => makeStyles(colors), [colors]);
  const scrollRef  = useRef<ScrollView>(null);

  const prevLenRef = useRef(0);
  useEffect(() => {
    if (lines.length !== prevLenRef.current) {
      prevLenRef.current = lines.length;
      scrollRef.current?.scrollToEnd({ animated: false });
    }
  }, [lines.length]);

  const handleRun   = useCallback(() => { void run(); }, [run]);
  const handleClear = useCallback(() => clear(),         [clear]);
  const handleStop  = useCallback(() => stop(),          [stop]);

  return (
    <View style={S.root}>

      {/* Toolbar */}
      <View style={[S.toolbar, { paddingTop: top + 8 }]}>
        <View style={S.toolbarLeft}>
          <Text style={S.toolbarTitle}>⬛ Terminal</Text>
          <Text style={S.toolbarSub}>{lines.length} satır</Text>
        </View>
        <View style={S.toolbarActions}>
          {isRunning ? (
            <Pressable style={[S.btn, S.btnDanger]} onPress={handleStop}>
              <Text style={S.btnText}>■ Durdur</Text>
            </Pressable>
          ) : (
            <Pressable style={[S.btn, S.btnRun]} onPress={handleRun}>
              <Text style={[S.btnText, S.btnRunText]}>▶ Çalıştır</Text>
            </Pressable>
          )}
          <Pressable style={S.btn} onPress={handleClear}>
            <Text style={S.btnText}>✕ Temizle</Text>
          </Pressable>
        </View>
      </View>

      {/* Çıktı */}
      <ScrollView
        ref={scrollRef}
        style={S.output}
        contentContainerStyle={S.outputContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {lines.length === 0 ? (
          <View style={S.emptyWrap}>
            <Text style={S.emptyIcon}>⬛</Text>
            <Text style={S.emptyTitle}>Terminal Hazır</Text>
            <Text style={S.emptyDesc}>▶ Çalıştır'a basın veya bir dosya kaydedin.</Text>
          </View>
        ) : (
          lines.map(line => (
            <TerminalLineRow
              key={line.id}
              line={line}
              lineColors={S.lineColors}
              lineTextStyle={S.lineText}
              timestampStyle={S.timestamp}
            />
          ))
        )}
      </ScrollView>

      {/* Status bar */}
      <View style={S.statusBar}>
        {isRunning && (
          <ActivityIndicator
            size="small"
            color={colors.terminal.success}
            style={{ marginRight: 6 }}
          />
        )}
        <Text style={S.statusText}>
          {isRunning ? 'Çalışıyor…' : `Kapasite: ${RING_CAPACITY} satır`}
        </Text>
      </View>
    </View>
  );
}
