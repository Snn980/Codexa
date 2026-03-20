/**
 * storage/chat/SessionSearchIndex.ts
 *
 * § 40 (T-P15-1) — Session başlık ve preview araması.
 *
 * FlexSearch kullanır; import başarısız olursa (bundle sorunu, test ortamı)
 * linear fallback devreye girer — davranış aynı, sadece performans düşer.
 * MAX_SESSIONS=50 olduğundan linear scan bile O(50) → kabul edilebilir.
 *
 * Tasarım kararları:
 *   • Index her SessionMeta listesi değiştiğinde rebuild edilir (50 kayıt, ucuz).
 *   • Arama senkron — useSessionSearch hook'unda debounce uygulanır.
 *   • Türkçe karakter normalizasyonu: ş→s, ğ→g, ı→i, ö→o, ü→u, ç→c
 *     FlexSearch'ün Türkçe tokenizer'ı yoktur; normalizasyon bunu telafi eder.
 *   • id döndürür — caller SessionMeta'yı kendi listesinden filtreler.
 *
 * § 1  : Result<T>
 */

import type { SessionMeta }  from './ChatHistoryRepository';

// ─── Türkçe normalizasyon ──────────────────────────────────────────────────────

const TR_MAP: Record<string, string> = {
  ş: 's', Ş: 'S', ğ: 'g', Ğ: 'G',
  ı: 'i', İ: 'I', ö: 'o', Ö: 'O',
  ü: 'u', Ü: 'U', ç: 'c', Ç: 'C',
};

function normalize(str: string): string {
  return str
    .replace(/[şŞğĞıİöÖüÜçÇ]/g, c => TR_MAP[c] ?? c)
    .toLowerCase()
    .trim();
}

// ─── FlexSearch dinamik import ────────────────────────────────────────────────

type FlexDocument = {
  add(id: number, content: string): void;
  search(query: string, limit?: number): number[];
  remove(id: number): void;
};

async function tryLoadFlexSearch(): Promise<FlexDocument | null> {
  try {
    // FlexSearch v0.7+ ESM / CJS uyumlu
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flex = await import('flexsearch' as any);
    const Ctor = flex.Index ?? flex.default?.Index ?? flex.default;
    if (typeof Ctor !== 'function') return null;
    return new Ctor({
      tokenize:  'forward',   // prefix matching: "reac" → "react"
      resolution: 9,
      cache:     true,
    }) as FlexDocument;
  } catch {
    return null;
  }
}

// ─── Linear fallback ──────────────────────────────────────────────────────────

class LinearIndex implements FlexDocument {
  private _docs = new Map<number, string>();

  add(id: number, content: string): void {
    this._docs.set(id, content);
  }

  search(query: string, limit = 20): number[] {
    const q       = normalize(query);
    const results: number[] = [];
    for (const [id, content] of this._docs) {
      if (normalize(content).includes(q)) results.push(id);
      if (results.length >= limit) break;
    }
    return results;
  }

  remove(id: number): void {
    this._docs.delete(id);
  }
}

// ─── SessionSearchIndex ───────────────────────────────────────────────────────

export class SessionSearchIndex {

  private _index: FlexDocument = new LinearIndex(); // başlangıçta linear
  private _idToSession = new Map<number, string>(); // numeric id → session uuid
  private _ready       = false;
  private _initPromise: Promise<void> | null = null;

  constructor() {
    this._initPromise = this._init();
  }

  private async _init(): Promise<void> {
    const flex = await tryLoadFlexSearch();
    if (flex) this._index = flex;
    this._ready = true;
  }

  /** FlexSearch yüklenene kadar bekle */
  async ready(): Promise<void> {
    await this._initPromise;
  }

  /**
   * Session listesini index'e yükle.
   * Her çağrıda index temizlenir ve yeniden oluşturulur.
   * MAX_SESSIONS=50 olduğundan bu ucuzdur.
   */
  rebuild(sessions: readonly SessionMeta[]): void {
    this._idToSession.clear();

    // FlexSearch numerik id kullanır; uuid yerine sıralı int
    sessions.forEach((s, i) => {
      const numId   = i + 1;   // 0 kaçınmak için
      const content = normalize(`${s.title} ${s.preview}`);
      this._idToSession.set(numId, s.id);
      this._index.add(numId, content);
    });
  }

  /**
   * Arama yap. Senkron.
   * @param query  Ham kullanıcı girdisi (Türkçe destekli)
   * @param limit  Maksimum sonuç sayısı (default: 20)
   * @returns      Eşleşen session UUID listesi
   */
  search(query: string, limit = 20): string[] {
    if (!query.trim()) return [];

    const normalizedQuery = normalize(query);
    const numIds          = this._index.search(normalizedQuery, limit);

    return numIds
      .map(id => this._idToSession.get(id))
      .filter((id): id is string => id !== undefined);
  }

  /**
   * Tek session'ı index'ten kaldır (silme sonrası).
   */
  removeSession(sessionId: string): void {
    for (const [numId, uuid] of this._idToSession) {
      if (uuid === sessionId) {
        this._index.remove(numId);
        this._idToSession.delete(numId);
        break;
      }
    }
  }
}

// Module-level singleton
export const sessionSearchIndex = new SessionSearchIndex();
