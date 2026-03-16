/**
 * hooks/useSessionSearch.ts
 *
 * § 40 (T-P15-1) — Session arama hook'u.
 *
 * SessionSearchIndex üzerinde debounced arama.
 * useChatHistory ile birlikte kullanılır:
 *
 *   const { sessions }          = useChatHistory(db);
 *   const { results, isSearching } = useSessionSearch(sessions);
 *
 * § 8  : mountedRef + useCallback + useMemo
 * § 1  : Result<T> değil — search pure UI state, hata UI'da gizlenir
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { SessionMeta }       from '../storage/chat/ChatHistoryRepository';
import { sessionSearchIndex }     from '../storage/chat/SessionSearchIndex';

// ─── Sabitler ─────────────────────────────────────────────────────────────────

/** Kullanıcı yazmayı bıraktıktan sonra arama başlar (ms) */
const DEBOUNCE_MS  = 200;
const MAX_RESULTS  = 20;

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface UseSessionSearchReturn {
  /** Aktif query */
  query:       string;
  /** Query setter */
  setQuery:    (q: string) => void;
  /**
   * Arama sonuçları.
   * query boşsa tüm session'lar döner (filtresiz liste).
   */
  results:     readonly SessionMeta[];
  /** Debounce süresince true */
  isSearching: boolean;
  /** Index'i temizle */
  clearQuery:  () => void;
}

export function useSessionSearch(
  allSessions: readonly SessionMeta[],
): UseSessionSearchReturn {

  const [query,       setQueryRaw]   = useState('');
  const [results,     setResults]    = useState<readonly SessionMeta[]>(allSessions);
  const [isSearching, setIsSearching] = useState(false);

  const mountedRef   = useRef(true);
  const debounceRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Index'i session listesi değiştiğinde rebuild et
  useEffect(() => {
    sessionSearchIndex.rebuild(allSessions);
    // Query varsa sonuçları güncelle
    if (query.trim()) {
      const ids     = sessionSearchIndex.search(query, MAX_RESULTS);
      const idSet   = new Set(ids);
      setResults(allSessions.filter(s => idSet.has(s.id)));
    } else {
      setResults(allSessions);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allSessions]);

  // Query değişince debounced arama
  const setQuery = useCallback((q: string) => {
    setQueryRaw(q);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!q.trim()) {
      setIsSearching(false);
      setResults(allSessions);
      return;
    }

    setIsSearching(true);

    debounceRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      const ids   = sessionSearchIndex.search(q, MAX_RESULTS);
      const idSet = new Set(ids);
      setResults(allSessions.filter(s => idSet.has(s.id)));
      setIsSearching(false);
    }, DEBOUNCE_MS);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allSessions]);

  const clearQuery = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setQueryRaw('');
    setIsSearching(false);
    setResults(allSessions);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allSessions]);

  // Cleanup debounce on unmount
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  return useMemo(() => ({
    query,
    setQuery,
    results,
    isSearching,
    clearQuery,
  }), [query, setQuery, results, isSearching, clearQuery]);
}
