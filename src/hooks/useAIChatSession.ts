/**
 * hooks/useAIChatSession.ts
 *
 * Chat oturum yönetimi:
 *   - Aktif session oluştur / yükle / sil
 *   - Her mesaj sonrası otomatik kaydet
 *   - Oturum listesi (SessionMeta[])
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppContext } from '@/app/AppContext';
import { generateId }   from '../utils/uuid';
import type { ChatMessage } from './useAIChat';
import type { SessionMeta } from '../storage/chat/ChatHistoryRepository';

export interface UseAIChatSessionReturn {
  sessionId:       string;
  sessions:        readonly SessionMeta[];
  loadSession:     (id: string) => readonly ChatMessage[];
  saveMessages:    (messages: readonly ChatMessage[]) => void;
  newSession:      () => string;
  deleteSession:   (id: string) => void;
  refreshSessions: () => void;
}

export function useAIChatSession(): UseAIChatSessionReturn {
  const { services }   = useAppContext();
  const repo           = services.chatHistory;
  const sessionIdRef   = useRef<string>(generateId());
  const [sessionId, setSessionId] = useState(sessionIdRef.current);
  const [sessions, setSessions]   = useState<readonly SessionMeta[]>([]);

  // Oturum listesini yükle
  const refreshSessions = useCallback(() => {
    const result = repo.listSessions();
    if (result.ok) setSessions(result.data);
  }, [repo]);

  useEffect(() => { refreshSessions(); }, [refreshSessions]);

  // Belirtilen session'ın mesajlarını döndür
  const loadSession = useCallback((id: string): readonly ChatMessage[] => {
    const result = repo.getMessages(id);
    return result.ok ? result.data : [];
  }, [repo]);

  // Mevcut session'a mesajları kaydet
  const saveMessages = useCallback((messages: readonly ChatMessage[]) => {
    if (messages.length === 0) return;
    const id    = sessionIdRef.current;
    const title = messages.find(m => m.role === 'user')?.content.slice(0, 40) ?? 'Yeni Sohbet';
    const existing = repo.getMessages(id);
    if (existing.ok && existing.data.length > 0) {
      repo.appendMessages(id, messages.slice(existing.data.length));
    } else {
      repo.createSession(id, title, messages);
    }
    refreshSessions();
  }, [repo, refreshSessions]);

  // Yeni oturum başlat
  const newSession = useCallback((): string => {
    const id = generateId();
    sessionIdRef.current = id;
    setSessionId(id);
    return id;
  }, []);

  // Oturumu sil
  const deleteSession = useCallback((id: string) => {
    repo.deleteSession(id);
    // Aktif session silindiyse yenisini başlat
    if (id === sessionIdRef.current) {
      const newId = generateId();
      sessionIdRef.current = newId;
      setSessionId(newId);
    }
    refreshSessions();
  }, [repo, refreshSessions]);

  return { sessionId, sessions, loadSession, saveMessages, newSession, deleteSession, refreshSessions };
}
