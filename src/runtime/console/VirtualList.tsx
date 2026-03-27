/**
 * @file     VirtualList.tsx
 * @module   runtime/console
 * @version  1.0.0
 * @since    Phase 2 — Runtime Sandbox
 *
 * @description
 *   RingBuffer çıktısını mobil için sanallaştırılmış liste olarak render eder.
 *   10_000 satıra kadar akıcı scroll — yalnızca görünür pencere DOM'a eklenir
 *   (React Native FlatList + getItemLayout sabit yükseklik optimizasyonu).
 *
 * Veri akışı:
 *
 *   ConsoleStream
 *     │  buffer.subscribe(entry) → pendingRef → [16ms flush] → setItems
 *     │  eventBus.on("runtime:started")  → items sıfırlanır
 *     │  eventBus.on("runtime:finished") → isRunning=false
 *     ▼
 *   VirtualList  →  FlatList  →  ConsoleLine
 *
 * Tasarım kararları:
 *   • `buffer.subscribe()` ile incremental güncelleme — EventBus'u bypass eder,
 *     double-emit yok, daha düşük latency.
 *   • Batch flush (16ms) — 10K satır hızlı geldiğinde setState bombardımanı önler.
 *     React 18 auto-batching ile uyumlu; her frame maksimum 1 re-render.
 *   • `runtime:started` event'inde pending + state sıfırlanır — buffer.clear()
 *     subscriber'ları tetiklemediği için EventBus dinlemek zorunlu.
 *   • `getItemLayout` — sabit ITEM_HEIGHT ile O(1) scroll hesabı.
 *     Uzun satırlar NativeGuard tarafından kısaltıldığı için satır sarma yok.
 *   • Auto-scroll: kullanıcı alttaysa (SCROLL_THRESHOLD tolerans) yeni satırda
 *     `scrollToEnd` tetiklenir. Kullanıcı yukarı çıkmışsa otomatik scroll olmaz.
 *   • `droppedCount > 0` → liste başında banner — buffer overwrite bildirir.
 *   • `executionId` prop'u ile filtre: birden fazla çalıştırma buffer'da
 *     karışık olsa dahi sadece istenilen çalıştırma gösterilir.
 *   • `useRef` — timer ve mutable değerler için (Phase 1 kararı).
 *   • EventBus handler return değerleri (unsub fn) `useEffect` cleanup'ta çağrılır.
 *
 * @example
 *   // TerminalScreen.tsx içinde
 *   const stream = useConsoleStream(); // DI veya context
 *
 *   <VirtualList
 *     stream={stream}
 *     eventBus={eventBus}
 *     style={{ flex: 1 }}
 *     showTimestamps
 *   />
 *
 * @example
 *   // Belirli bir execution'ı filtrele
 *   <VirtualList
 *     stream={stream}
 *     eventBus={eventBus}
 *     executionId={currentExecutionId}
 *   />
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  FlatList,
  type ListRenderItemInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type ViewStyle,
} from "react-native";

import type { IEventBus, UUID } from "../../types/core";
import type { ConsoleStream }   from "./ConsoleStream";
import type { ConsoleEntry }    from "./RingBuffer";

// ─────────────────────────────────────────────────────────────────────────────
// § 1. Sabitler
// ─────────────────────────────────────────────────────────────────────────────

/** Her satır sabit yükseklikte — getItemLayout için zorunlu. */
const ITEM_HEIGHT = 20;

/**
 * Yeni satırları state'e flush etme gecikmesi (ms).
 * ~1 frame — rapid stream'de setState bombardımanı önler.
 */
const FLUSH_INTERVAL = 16;

/**
 * "Kullanıcı altta" toleransı (px).
 * ContentSize yüksekliği - scroll offset - layout yüksekliği <= bu değer → altta.
 */
const SCROLL_THRESHOLD = 40;

/**
 * State'te tutulacak maksimum satır sayısı.
 * VSCode terminal mantığı: eski satırlar otomatik silinir, RAM büyümez.
 * Mobil IDE'de uzun süreli çalıştırmalarda kritik.
 */
const MAX_RENDERED_LINES = 10_000;

// ─────────────────────────────────────────────────────────────────────────────
// § 2. Yardımcı Fonksiyonlar
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Unix timestamp'i `HH:MM:SS.mmm` formatına çevirir.
 *
 * @example
 *   formatTime(Date.now()) // "14:32:07.042"
 */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh  = String(d.getHours()).padStart(2, "0");
  const mm  = String(d.getMinutes()).padStart(2, "0");
  const ss  = String(d.getSeconds()).padStart(2, "0");
  const ms  = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

/**
 * Timestamp string önbelleği.
 * Her benzersiz `ts` değeri yalnızca bir kez `Date` oluşturur.
 * 10K satır → 10K yerine en fazla N farklı ms değeri kadar hesaplama.
 * MAX_RENDERED_LINES aşılmadığı sürece boyut kontrolsüz büyümez.
 */
const tsCache = new Map<number, string>();

function cachedFormatTime(ts: number): string {
  let result = tsCache.get(ts);
  if (result === undefined) {
    result = formatTime(ts);
    tsCache.set(ts, result);
    // Cache'i sınırlı tut — bellek sızıntısı önlemi
    if (tsCache.size > MAX_RENDERED_LINES) {
      const firstKey = tsCache.keys().next().value;
      if (firstKey !== undefined) tsCache.delete(firstKey);
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 3. ConsoleLine — Satır Bileşeni
// ─────────────────────────────────────────────────────────────────────────────

interface ConsoleLineProps {
  item:            ConsoleEntry;
  showTimestamps:  boolean;
}

/**
 * Tek bir konsol satırını render eder.
 * Custom comparator: yalnızca `seq` değiştiğinde yeniden render edilir.
 * `showTimestamps` değişimi de karşılaştırmaya dahil — prop tam eşitliği.
 */
const ConsoleLine = React.memo(
  function ConsoleLine({ item, showTimestamps }: ConsoleLineProps) {
    const isError = item.stream === "stderr";

    return (
      <View style={styles.row}>
        {showTimestamps && (
          <Text style={styles.timestamp} numberOfLines={1}>
            {cachedFormatTime(item.ts)}
          </Text>
        )}
        <Text
          style={[styles.line, isError && styles.lineError]}
          numberOfLines={1}
          selectable
        >
          {item.line}
        </Text>
      </View>
    );
  },
  // Custom comparator — seq monotonic & immutable; showTimestamps nadiren değişir
  (a, b) => a.item.seq === b.item.seq && a.showTimestamps === b.showTimestamps,
);

// ─────────────────────────────────────────────────────────────────────────────
// § 4. Props
// ─────────────────────────────────────────────────────────────────────────────

export interface VirtualListProps {
  /**
   * ConsoleStream instance'ı — buffer ve worker bağlantısını içerir.
   * Değişmesi beklenmez; değişirse tüm state sıfırlanır.
   */
  readonly stream: ConsoleStream;

  /**
   * EventBus — `runtime:started` / `runtime:finished` / `runtime:error`
   * event'leri için gerekli. TerminalScreen DI'dan alır.
   */
  readonly eventBus: IEventBus;

  /**
   * İsteğe bağlı execution filtresi.
   * `null` veya `undefined` → tüm buffer gösterilir.
   * UUID verilirse yalnızca o çalıştırmaya ait satırlar listelenir.
   */
  readonly executionId?: UUID | null;

  /**
   * Satır başında zaman damgası (`HH:MM:SS.mmm`) göster.
   * Varsayılan: false — mobil ekranda yatay alan tasarrufu.
   */
  readonly showTimestamps?: boolean;

  /** Dış container stil override'ı. */
  readonly style?: StyleProp<ViewStyle>;

  /** Otomasyon / test için testID. */
  readonly testID?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 5. VirtualList
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sanallaştırılmış konsol çıktı listesi.
 *
 * Büyük çıktı setlerini (10K satır) mobilde akıcı render eder.
 * RingBuffer'a doğrudan abone olur; her frame en fazla bir setState tetiklenir.
 *
 * @see ConsoleStream
 * @see RingBuffer
 */
export const VirtualList = React.memo(function VirtualList({
  stream,
  eventBus,
  executionId,
  showTimestamps = false,
  style,
  testID,
}: VirtualListProps) {

  // ── § 5.1 State ───────────────────────────────────────────────────────────

  /**
   * Render edilecek satır listesi.
   * İlk değer: mount anındaki buffer snapshot'ı (filtre uygulanmış).
   */
  const [items, setItems] = useState<ConsoleEntry[]>(() =>
    executionId !== null
      ? (executionId ? stream.buffer.forExecution(executionId) || [] : [])
      : stream.buffer.toArray(),
  );

  /**
   * Buffer overwrite sayacı — banner göstergesi için.
   * Buffer'a yeni satır eklendiğinde güncellenir.
   */
  const [droppedCount, setDroppedCount] = useState(
    stream.buffer.droppedCount,
  );

  /**
   * Çalışma durumu — boş liste mesajını kontrol eder.
   * `runtime:started` → true, `runtime:finished` / `runtime:error` → false.
   */
  const [isRunning, setIsRunning] = useState(false);

  /**
   * "Aşağı kaydır" butonu görünürlüğü.
   * Kullanıcı listeyi yukarı çektiğinde gösterilir.
   */
  const [showScrollButton, setShowScrollButton] = useState(false);

  /**
   * Kullanıcı yukarıdayken gelen görülmemiş satır sayısı.
   * Scroll butonu üzerinde "52 yeni satır ↓" göstergesi için.
   */
  const [unseenCount, setUnseenCount] = useState(0);

  // ── § 5.2 Ref'ler ─────────────────────────────────────────────────────────

  /** FlatList referansı — `scrollToEnd` çağrıları için. */
  const flatListRef = useRef<FlatList<ConsoleEntry>>(null);

  /** Kullanıcının listenin altında olup olmadığı. */
  const isAtBottomRef = useRef(true);

  /**
   * Flush bekleyen girişler.
   * Her frame'de tek setState çağrısı için kullanılır.
   */
  const pendingRef = useRef<ConsoleEntry[]>([]);

  /**
   * Batch flush timer handle.
   * Phase 1 kararı: timer ref'te tutulur, cleanup'ta temizlenir.
   */
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── § 5.3 Batch Flush ─────────────────────────────────────────────────────

  /**
   * Bekleyen tüm girişleri tek seferde state'e yazar.
   * setTimeout callback'i olarak ~1 frame sonra çalışır.
   *
   * Optimizasyonlar:
   *   • splice yerine ref swap → array mutasyonu yok, daha hızlı
   *   • MAX_RENDERED_LINES → eski satırları sil, RAM büyümez (VSCode terminal mantığı)
   *   • unseenCount → kullanıcı yukarıdayken kaç satır geldiğini göster
   */
  const flushPending = useCallback(() => {
    flushTimerRef.current = null;

    // ✅ #5: splice yerine ref swap — array mutasyonu yok, O(1)
    const batch = pendingRef.current;
    pendingRef.current = [];
    if (batch.length === 0) return;

    setItems((prev) => {
      const next = [...prev, ...batch];
      // ✅ #1: VSCode terminal mantığı — eski satırları sil, RAM sınırlı kalır
      return next.length > MAX_RENDERED_LINES
        ? next.slice(-MAX_RENDERED_LINES)
        : next;
    });
    setDroppedCount(stream.buffer.droppedCount);

    // ✅ #7: Kullanıcı yukarıdayken görülmemiş satır sayacını artır
    if (!isAtBottomRef.current) {
      setUnseenCount((n) => n + batch.length);
    }
  }, [stream]);

  // ── § 5.4 RingBuffer Aboneliği ────────────────────────────────────────────

  useEffect(() => {
    /** Execution filtresi — null/undefined → tüm satırları kabul et. */
    const accept = (entry: ConsoleEntry): boolean =>
      executionId === null || entry.executionId === executionId;

    const unsub = stream.buffer.subscribe((entry) => {
      if (!accept(entry)) return;

      pendingRef.current.push(entry);

      // Flush timer zaten kuruluysa yeni kurmaya gerek yok
      if (flushTimerRef.current === null) {
        flushTimerRef.current = setTimeout(flushPending, FLUSH_INTERVAL);
      }
    });

    return () => {
      unsub();
      // Cleanup: bekleyen timer'ı iptal et, pending'i boşalt
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      pendingRef.current = [];
    };
  }, [stream, executionId, flushPending]);

  // ── § 5.5 ExecutionId Değişimi ────────────────────────────────────────────

  /**
   * `executionId` prop'u değiştiğinde buffer'dan yeniden snapshot al.
   * Subscription effect de yeniden çalışacağı için unsub/resub otomatik.
   */
  useEffect(() => {
    setItems(
      executionId !== null
        ? (executionId ? stream.buffer.forExecution(executionId) || [] : [])
        : stream.buffer.toArray(),
    );
    setDroppedCount(stream.buffer.droppedCount);
  }, [stream, executionId]);

  // ── § 5.6 EventBus — Runtime Yaşam Döngüsü ────────────────────────────────

  useEffect(() => {
    /**
     * `runtime:started` → state sıfırla.
     *
     * buffer.clear() subscriber'ları tetiklemez; bu nedenle EventBus
     * dinlemek zorunludur. Pending flush da iptal edilir — eski çalıştırmanın
     * son satırları yeni çalıştırmanın listesine karışmaz.
     */
    const unsubStarted = eventBus.on(
      "runtime:started",
      ({ executionId: incomingId }) => {
        // Filtre aktifse yalnızca ilgili execution'ı işle
        if (executionId !== null && incomingId !== executionId) return;

        // Pending flush iptal — eski satırlar karışmasın
        if (flushTimerRef.current !== null) {
          clearTimeout(flushTimerRef.current);
          flushTimerRef.current = null;
        }
        pendingRef.current = [];

        setItems([]);
        setDroppedCount(0);
        setIsRunning(true);
        setShowScrollButton(false);
        setUnseenCount(0);

        // Yeni çalıştırma başında listeyi en üste getir
        // (scrollToEnd yeni satırlar gelince devreye girecek)
        isAtBottomRef.current = true;
      },
    );

    const unsubFinished = eventBus.on(
      "runtime:finished",
      ({ executionId: incomingId }) => {
        if (executionId !== null && incomingId !== executionId) return;
        setIsRunning(false);
      },
    );

    const unsubError = eventBus.on(
      "runtime:error",
      ({ executionId: incomingId }) => {
        if (executionId !== null && incomingId !== executionId) return;
        setIsRunning(false);
      },
    );

    return () => {
      unsubStarted();
      unsubFinished();
      unsubError();
    };
  }, [eventBus, executionId]);

  // ── § 5.7 Auto-Scroll ─────────────────────────────────────────────────────

  /**
   * Content boyutu değiştiğinde çağrılır.
   * Kullanıcı alttaysa otomatik `scrollToEnd` tetiklenir.
   */
  const handleContentSizeChange = useCallback(() => {
    if (isAtBottomRef.current) {
      flatListRef.current?.scrollToEnd({ animated: false });
    }
  }, []);

  /**
   * Scroll pozisyonunu izler.
   * Kullanıcı altta değilse "aşağı kaydır" butonu gösterilir.
   */
  const handleScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
      const distanceFromBottom =
        contentSize.height - (contentOffset.y + layoutMeasurement.height);

      const atBottom = distanceFromBottom <= SCROLL_THRESHOLD;
      isAtBottomRef.current = atBottom;
      setShowScrollButton(!atBottom);

      // ✅ #7: Kullanıcı alta döndüğünde görülmemiş sayacı sıfırla
      if (atBottom) setUnseenCount(0);
    },
    [],
  );

  /** "Aşağı kaydır" butonu handler'ı. */
  const handleScrollToBottom = useCallback(() => {
    isAtBottomRef.current = true;
    setShowScrollButton(false);
    setUnseenCount(0);
    flatListRef.current?.scrollToEnd({ animated: true });
  }, []);

  // ── § 5.8 FlatList Optimizasyon Callback'leri ─────────────────────────────

  /**
   * Stable key: `entry.seq` — monotonic, sıfırlanmaz.
   * RingBuffer garantisi: clear() sonrasında seq artmaya devam eder.
   */
  const keyExtractor = useCallback(
    (item: ConsoleEntry) => String(item.seq),
    [],
  );

  /**
   * Sabit yükseklik layout hesabı.
   * NativeGuard satırları kısalttığı için tek satır garantisi var.
   */
  const getItemLayout = useCallback(
    (_data: ArrayLike<ConsoleEntry> | null | undefined, index: number) => ({
      length: ITEM_HEIGHT,
      offset: ITEM_HEIGHT * index,
      index,
    }),
    [],
  );

  /** Satır render fonksiyonu — `showTimestamps` kapanışta stabil. */
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<ConsoleEntry>) => (
      <ConsoleLine item={item} showTimestamps={showTimestamps} />
    ),
    [showTimestamps],
  );

  // ── § 5.9 Liste Dekoratörleri ─────────────────────────────────────────────

  /**
   * Dropped lines banner — buffer taştığında listenin tepesinde gösterilir.
   * ✅ #2: useMemo ile sarıldı — droppedCount değişmediği sürece FlatList
   * header değişmedi sanmaz, gereksiz re-render önlenir.
   */
  const ListHeaderComponent = useMemo(() => {
    if (droppedCount === 0) return null;
    return (
      <View style={styles.droppedBanner} accessibilityRole="alert">
        <Text style={styles.droppedText}>
          {`⚠ En eski ${droppedCount} satır tampon kapasitesi aşıldığı için silindi`}
        </Text>
      </View>
    );
  }, [droppedCount]);

  /**
   * Boş liste mesajı.
   * Çalışma sırasında gösterilmez (satırlar henüz gelmemiş olabilir).
   */
  const ListEmptyComponent =
    !isRunning ? (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>
          {"Çıktı yok — ▶ ile çalıştırın"}
        </Text>
      </View>
    ) : null;

  // ── § 5.10 Render ─────────────────────────────────────────────────────────

  return (
    <View style={[styles.container, style]} testID={testID}>
      <FlatList
        ref={flatListRef}
        data={items}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        getItemLayout={getItemLayout}
        ListHeaderComponent={ListHeaderComponent}
        ListEmptyComponent={ListEmptyComponent}
        onScroll={handleScroll}
        scrollEventThrottle={16}          // ✅ #3: 100→16, akıcı scroll detection (~1 frame)
        onContentSizeChange={handleContentSizeChange}
        // ── Render penceresi ayarları ──────────────────────────────
        windowSize={5}            // görünür alan + 2 sayfa tampon
        maxToRenderPerBatch={50}  // tek seferde render edilecek satır
        initialNumToRender={30}   // ilk frame render sayısı
        updateCellsBatchingPeriod={10}
        removeClippedSubviews={items.length > 200} // ✅ #4: koşullu — bazı RN versiyonlarında bug var
        // ── Görünüm ───────────────────────────────────────────────
        style={styles.list}
        contentContainerStyle={
          items.length === 0 ? styles.emptyContentContainer : undefined
        }
        // ── Erişilebilirlik ───────────────────────────────────────
        accessibilityLabel="Konsol çıktısı"
        accessibilityRole="list"
      />

      {/* ✅ #7: Aşağı kaydır FAB — yeni satır sayısı ile birlikte */}
      {showScrollButton && (
        <TouchableOpacity
          style={[styles.scrollButton, unseenCount > 0 && styles.scrollButtonActive]}
          onPress={handleScrollToBottom}
          activeOpacity={0.8}
          accessibilityLabel={
            unseenCount > 0
              ? `${unseenCount} yeni satır, en alta kaydır`
              : "En alta kaydır"
          }
          accessibilityRole="button"
        >
          {unseenCount > 0 ? (
            <Text style={styles.scrollButtonBadge}>
              {unseenCount > 999 ? "999+ ↓" : `${unseenCount} ↓`}
            </Text>
          ) : (
            <Text style={styles.scrollButtonText}>{"↓"}</Text>
          )}
        </TouchableOpacity>
      )}
    </View>
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// § 6. Stiller
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Renk paleti: VS Code Dark+ teması ile uyumlu.
 * Monospace font — platform native fallback zinciri.
 */
const COLORS = {
  bg:          "#0d1117",  // GitHub Dark arka plan
  textNormal:  "#e6edf3",  // açık metin
  textError:   "#ff7b72",  // stderr kırmızı
  textMuted:   "#484f58",  // soluk metin
  textTs:      "#6e7681",  // timestamp gri
  bannerBg:    "rgba(110, 64, 20, 0.3)", // amber, yarı saydam
  bannerText:  "#e3b341",  // amber
  buttonBg:    "rgba(22, 27, 34, 0.9)",
  buttonBorder:"#30363d",
  buttonText:  "#e6edf3",
} as const;

const FONT_MONO =
  "Menlo, 'Courier New', Courier, monospace" as unknown as string;

const styles = StyleSheet.create({
  container: {
    flex:            1,
    backgroundColor: COLORS.bg,
    position:        "relative",
  },
  list: {
    flex: 1,
  },

  // ── Satır ──────────────────────────────────────────────────────
  row: {
    height:           ITEM_HEIGHT,
    flexDirection:    "row",
    alignItems:       "center",
    paddingHorizontal: 8,
  },
  timestamp: {
    fontFamily: FONT_MONO,
    fontSize:   11,
    color:      COLORS.textTs,
    marginRight: 6,
    width:       80,
  },
  line: {
    fontFamily: FONT_MONO,
    fontSize:   13,
    color:      COLORS.textNormal,
    flex:        1,
  },
  lineError: {
    color: COLORS.textError,
  },

  // ── Dropped Banner ─────────────────────────────────────────────
  droppedBanner: {
    backgroundColor:  COLORS.bannerBg,
    paddingHorizontal: 8,
    paddingVertical:   4,
    borderLeftWidth:   3,
    borderLeftColor:   COLORS.bannerText,
  },
  droppedText: {
    fontFamily: FONT_MONO,
    fontSize:   12,
    color:      COLORS.bannerText,
  },

  // ── Boş Durum ──────────────────────────────────────────────────
  emptyContentContainer: {
    flex:           1,
    justifyContent: "center",
    alignItems:     "center",
  },
  emptyContainer: {
    alignItems: "center",
    padding:    24,
  },
  emptyText: {
    fontFamily: FONT_MONO,
    fontSize:   13,
    color:      COLORS.textMuted,
  },

  // ── Scroll-to-Bottom FAB ───────────────────────────────────────
  scrollButton: {
    position:        "absolute",
    bottom:          12,
    right:           12,
    minWidth:        36,
    height:          36,
    borderRadius:    18,
    backgroundColor: COLORS.buttonBg,
    borderWidth:     1,
    borderColor:     COLORS.buttonBorder,
    alignItems:      "center",
    justifyContent:  "center",
    paddingHorizontal: 8,
    // Gölge — Android elevation + iOS shadow
    elevation:       4,
    shadowColor:     "#000",
    shadowOffset:    { width: 0, height: 2 },
    shadowOpacity:   0.4,
    shadowRadius:    3,
  },
  // Yeni satır varken amber vurgu
  scrollButtonActive: {
    borderColor:     COLORS.bannerText,
    backgroundColor: "rgba(22, 27, 34, 0.95)",
  },
  scrollButtonText: {
    fontFamily: FONT_MONO,
    fontSize:   16,
    color:      COLORS.buttonText,
    lineHeight: 20,
  },
  // "52 ↓" badge metni
  scrollButtonBadge: {
    fontFamily: FONT_MONO,
    fontSize:   12,
    color:      COLORS.bannerText,
    lineHeight: 20,
    fontWeight: "600" as const,
  },
});
