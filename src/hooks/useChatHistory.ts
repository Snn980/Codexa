// src/hooks/useChatHistory.ts
// § 37 — Chat history hook
//
// Kural:
//   - § 8: mountedRef, useCallback, useMemo
//   - § 1: Result<T> — hata UI'ya iletilir, veri kaybı olmaz
//   - Otomatik title üretimi — § 17.3 autoTitle uyumlu
//   - Session değiştirme — messages anlık yüklenir (senkron MMKV)
//   - Persist her mesaj gönderiminde değil, stream tamamlandığında yapılır

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { generateId }            from '../utils/uuid';
import { ChatHistoryRepository } from '../storage/chat/ChatHistoryRepository';
import type { ChatMessage }      from './useAIChat';
import type { SessionMeta }      from '../storage/chat/ChatHistoryRepository';

// ─── Sabitler ─────────────────────────────────────────────────────────────────

const UNTITLED = 'Yeni Sohbet';

// ─── Repository singleton ─────────────────────────────────────────────────────
// useChatHistory her render'da yeni instance oluşturmamalı.
// MMKV aynı id ile çağrılırsa cached instance döner — zaten safe.
// Fakat DI için factory inject edilebilir.

let _defaultRepo: ChatHistoryRepository | null = null;
function getDefaultRepo(): ChatHistoryRepository {
  if (!_defaultRepo) _defaultRepo = new ChatHistoryRepository();
  return _defaultRepo;
}

// ─── Tipler ───────────────────────────────────────────────────────────────────

export interface UseChatHistoryOptions {
  /** Inject edilebilir — test için */
  repository?:   ChatHistoryRepository;
  initialSession?: string | null;
}

export interface UseChatHistoryReturn {
  // State
  sessions:          readonly SessionMeta[];
  activeSessionId:   string | null;
  activeMessages:    readonly ChatMessage[];
  isLoading:         boolean;
  error:             string | null;
  // Actions
  newSession:        () => string;
  loadSession:       (id: string) => void;
  saveMessages:      (messages: readonly ChatMessage[]) => void;
  renameSession:     (id: string, title: string) => void;
  deleteSession:     (id: string) => void;
  clearError:        () => void;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useChatHistory(
  opts: UseChatHistoryOptions = {},
): UseChatHistoryReturn {
  const repo = opts.repository ?? getDefaultRepo();

  const [sessions,        setSessions]        = useState<readonly SessionMeta[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(
    opts.initialSession ?? null,
  );
  const [activeMessages,  setActiveMessages]  = useState<readonly ChatMessage[]>([]);
  const [isLoading,       setIsLoading]       = useState(false);
  const [error,           setError]           = useState<string | null>(null);

  // § 8 — mountedRef: async callback'lerde setState guard
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ── Session listesini yenile ──
  const refreshSessions = useCallback(() => {
    const result = repo.listSessions();
    if (!mountedRef.current) return;
    if (result.ok) {
      setSessions(result.data);
    } else {
      setError(result.error.message);
    }
  }, [repo]);

  // ── İlk yükleme ──
  useEffect(() => {
    refreshSessions();

    // initialSession varsa mesajlarını yükle
    if (opts.initialSession) {
      const msgResult = repo.getMessages(opts.initialSession);
      if (msgResult.ok && mountedRef.current) {
        setActiveMessages(msgResult.data);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Sadece mount'ta

  // ── Yeni session ──
  const newSession = useCallback((): string => {
    const id     = generateId();
    const result = repo.createSession(id, UNTITLED, []);
    if (result.ok) {
      setActiveSessionId(id);
      setActiveMessages([]);
      refreshSessions();
    } else {
      setError(result.error.message);
    }
    return id;
  }, [repo, refreshSessions]);

  // ── Session yükle (senkron MMKV → blok yok) ──
  const loadSession = useCallback((id: string) => {
    const result = repo.getMessages(id);
    if (result.ok) {
      setActiveSessionId(id);
      setActiveMessages(result.data);
      setError(null);
    } else {
      setError(result.error.message);
    }
  }, [repo]);

  // ── Mesajları kaydet (stream bitti / belirli aralıklarla) ──
  const saveMessages = useCallback((messages: readonly ChatMessage[]) => {
    if (!activeSessionId) return;

    // Session yoksa oluştur
    const metaRaw = repo.listSessions();
    const exists  = metaRaw.ok && metaRaw.data.some((s: { id: string }) => s.id === activeSessionId);

    if (!exists) {
      // Auto-title § 17.3
      const firstUser = messages.find((m) => m.role === 'user');
      const autoTitle = firstUser?.content.slice(0, 50).trim() ?? UNTITLED;
      repo.createSession(activeSessionId, autoTitle, messages);
    } else {
      repo.appendMessages(activeSessionId, messages);
    }

    refreshSessions();
  }, [activeSessionId, repo, refreshSessions]);

  // ── Rename ──
  const renameSession = useCallback((id: string, title: string) => {
    const result = repo.updateTitle(id, title);
    if (result.ok) {
      refreshSessions();
    } else {
      setError(result.error.message);
    }
  }, [repo, refreshSessions]);

  // ── Delete ──
  const deleteSession = useCallback((id: string) => {
    const result = repo.deleteSession(id);
    if (result.ok) {
      if (activeSessionId === id) {
        setActiveSessionId(null);
        setActiveMessages([]);
      }
      refreshSessions();
    } else {
      setError(result.error.message);
    }
  }, [repo, activeSessionId, refreshSessions]);

  const clearError = useCallback(() => setError(null), []);

  // ── Memoized sessions sıralaması (updatedAt DESC — repo zaten sıralıyor) ──
  const sortedSessions = useMemo(() => sessions, [sessions]);

  return {
    sessions:        sortedSessions,
    activeSessionId,
    activeMessages,
    isLoading,
    error,
    newSession,
    loadSession,
    saveMessages,
    renameSession,
    deleteSession,
    clearError,
  };
}
