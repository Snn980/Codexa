/**
 * hooks/useAISession.ts — Oturum yükleme, kaydetme, geçmiş restore
 *
 * § 1  : Result<T>
 * § 3  : IEventBus unsub cleanup
 * § 8  : useRef, useMemo
 *
 * DÜZELTMELER:
 *   ❗ RACE CONDITION : loadSession + appendMessages yarışı — activeSessionRef
 *      ile senkron kaynak-doğruluk sağlanır; stale session üzerine yazılmaz.
 *      Aynı anda birden fazla appendMessages çağrısı için _pendingAppend queue.
 *   💡 STALE CLOSURE  : useCallback dep array'leri kararlı ref'ler kullanır.
 *      repository ve eventBus ömür boyu sabit; newUUID de saf fn — dep gereksiz.
 *   💡 MEMOIZATION    : sessions listesi useMemo ile sort'lanır; her render'da
 *      yeniden sort yapılmaz.
 */

import {
  useState, useEffect, useCallback, useRef, useMemo,
} from "react";
import type {
  IAISessionRepository,
  AISession,
  AISessionSummary,
} from "../storage/AISessionRepository";
import type { IEventBus } from "../core/EventBus";
import type { UUID } from "../core/Types";
import type { AIModelId } from "../ai/AIModels";
import type { RuntimeMessage } from "../ai/IAIWorkerRuntime";

// ─── Hook state & actions ────────────────────────────────────────────────────

export type SessionLoadState = "idle" | "loading" | "ready" | "error";

export interface AISessionState {
  /** 💡 MEMOIZATION: updated_at DESC sıralı, stabil referans */
  sessions: AISessionSummary[];
  activeSession: AISession | null;
  loadState: SessionLoadState;
}

export interface AISessionActions {
  refreshList(): Promise<void>;
  loadSession(id: UUID): Promise<void>;
  createSession(modelId: AIModelId, firstUserMessage: string): Promise<UUID | null>;
  /** ❗ RACE: seri kuyruğa alınır, paralel yazma olmaz */
  appendMessages(newMessages: RuntimeMessage[], additionalTokens: number): Promise<void>;
  deleteActiveSession(): Promise<void>;
}

// ─── useAISession ─────────────────────────────────────────────────────────────

export interface UseAISessionOptions {
  repository: IAISessionRepository;
  eventBus: IEventBus;
  newUUID: () => UUID;
}

export function useAISession(opts: UseAISessionOptions): AISessionState & AISessionActions {
  const { repository, eventBus, newUUID } = opts;

  const [rawSessions, setRawSessions] = useState<AISessionSummary[]>([]);
  const [activeSession, setActiveSession] = useState<AISession | null>(null);
  const [loadState, setLoadState] = useState<SessionLoadState>("idle");

  const mountedRef = useRef(true);
  /** ❗ RACE: aktif session id — stale closure güvenli */
  const activeIdRef = useRef<UUID | null>(null);
  /** ❗ RACE: appendMessages seri kuyruk */
  const appendQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // 💡 MEMOIZATION: sort'u render dışına çıkar
  const sessions = useMemo<AISessionSummary[]>(
    () => [...rawSessions].sort((a, b) => b.updatedAt - a.updatedAt),
    [rawSessions],
  );

  // ─── refreshList ───────────────────────────────────────────────────────

  const refreshList = useCallback(async () => {
    const result = await repository.listSummaries();
    if (!mountedRef.current) return;
    if (result.ok) setRawSessions(result.data);
  }, [repository]);

  // ─── loadSession ──────────────────────────────────────────────────────

  const loadSession = useCallback(async (id: UUID) => {
    if (!mountedRef.current) return;
    setLoadState("loading");
    activeIdRef.current = id; // ❗ RACE: yeni yükleme başladı

    const result = await repository.getSession(id);
    if (!mountedRef.current) return;

    // ❗ RACE: yükleme sırasında başka loadSession çağrıldıysa eskiyi iptal et
    if (activeIdRef.current !== id) return;

    if (!result.ok) {
      setLoadState("error");
      return;
    }
    setActiveSession(result.data);
    setLoadState("ready");
    eventBus.emit("ai:session:loaded", { sessionId: id });
  }, [repository, eventBus]);

  // ─── createSession ─────────────────────────────────────────────────────

  const createSession = useCallback(async (
    modelId: AIModelId,
    firstUserMessage: string,
  ): Promise<UUID | null> => {
    const id = newUUID();
    const title = firstUserMessage.slice(0, 50).trimEnd()
      + (firstUserMessage.length > 50 ? "…" : "");

    const result = await repository.createSession({
      id,
      modelId,
      title,
      messages: [{ role: "user", content: firstUserMessage }],
      tokens: 0,
    });

    if (!mountedRef.current) return null;
    if (!result.ok) return null;

    activeIdRef.current = id;
    setActiveSession(result.data);
    setLoadState("ready");
    setRawSessions((prev) => [
      {
        id:        result.data.id,
        modelId:   result.data.modelId,
        title:     result.data.title,
        tokens:    result.data.tokens,
        updatedAt: result.data.updatedAt,
      },
      ...prev,
    ]);
    eventBus.emit("ai:session:created", { sessionId: id });
    return id;
  }, [repository, eventBus, newUUID]);

  // ─── appendMessages ───────────────────────────────────────────────────

  const appendMessages = useCallback(async (
    newMessages: RuntimeMessage[],
    additionalTokens: number,
  ) => {
    // ❗ RACE: kuyrukta sıraya gir — paralel appendMessages olmaz
    appendQueueRef.current = appendQueueRef.current.then(async () => {
      if (!mountedRef.current) return;
      const currentId = activeIdRef.current;
      if (!currentId) return;

      const result = await repository.appendMessages(currentId, newMessages, additionalTokens);
      if (!mountedRef.current) return;

      // ❗ RACE: append biterken aktif session değiştiyse güncelleme yapma
      if (activeIdRef.current !== currentId) return;

      if (!result.ok) return;
      setActiveSession(result.data);
      setRawSessions((prev) =>
        prev.map((s) =>
          s.id === result.data.id
            ? { ...s, tokens: result.data.tokens, updatedAt: result.data.updatedAt }
            : s,
        ),
      );
    });

    await appendQueueRef.current;
  }, [repository]);

  // ─── deleteActiveSession ──────────────────────────────────────────────

  const deleteActiveSession = useCallback(async () => {
    const id = activeIdRef.current;
    if (!id) return;

    await repository.deleteSession(id);
    if (!mountedRef.current) return;

    activeIdRef.current = null;
    setActiveSession(null);
    setLoadState("idle");
    setRawSessions((prev) => prev.filter((s) => s.id !== id));
    eventBus.emit("ai:session:deleted", { sessionId: id });
  }, [repository, eventBus]);

  // ─── İlk yükleme ─────────────────────────────────────────────────────

  useEffect(() => {
    void refreshList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // kasıtlı: sadece mount'ta çalışır

  // ─── EventBus ────────────────────────────────────────────────────────

  useEffect(() => {
    const unsub = eventBus.on("ai:session:refresh", () => { void refreshList(); });
    return () => unsub();
  }, [eventBus, refreshList]);

  return {
    sessions,
    activeSession,
    loadState,
    refreshList,
    loadSession,
    createSession,
    appendMessages,
    deleteActiveSession,
  };
}
