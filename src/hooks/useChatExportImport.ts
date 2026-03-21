/**
 * hooks/useChatExportImport.ts
 *
 * § 37 (T-P15-2) — Export/Import hook.
 *
 * expo-sharing ve expo-document-picker üzerinden çalışır.
 * Her ikisi de opsiyonel import — yoksa (web, simulator) graceful fallback.
 *
 * § 1  : Result<T>
 * § 8  : mountedRef + useCallback
 */

import {
  useCallback,
  useRef,
  useState,
} from 'react';

import type { ImportOptions, ImportSummary } from '../storage/chat/ChatExportImport';
import { ChatExportImport }                  from '../storage/chat/ChatExportImport';
import type { ChatHistoryRepository }        from '../storage/chat/ChatHistoryRepository';

// ─── Platform utilities (opsiyonel bağımlılık) ───────────────────────────────

async function shareText(text: string, filename: string): Promise<boolean> {
  try {
    // expo-file-system/legacy + expo-sharing (SDK 54+: eski API legacy'de)
    const FS      = await import('expo-file-system/legacy');
    const Sharing = await import('expo-sharing');

    const uri = `${FS.cacheDirectory}${filename}`;
    await FS.writeAsStringAsync(uri, text, { encoding: FS.EncodingType.UTF8 });

    const canShare = await Sharing.isAvailableAsync();
    if (!canShare) return false;

    await Sharing.shareAsync(uri, {
      mimeType: 'application/json',
      dialogTitle: 'Chat geçmişini paylaş',
    });
    return true;
  } catch {
    return false;
  }
}

async function pickJsonFile(): Promise<string | null> {
  try {
    const Picker = await import('expo-document-picker');
    const result = await Picker.getDocumentAsync({
      type:      'application/json',
      copyToCacheDirectory: true,
    });

    if (result.canceled || !result.assets?.[0]) return null;

    const FS  = await import('expo-file-system/legacy');
    const uri = result.assets[0].uri;
    return await FS.readAsStringAsync(uri, { encoding: FS.EncodingType.UTF8 });
  } catch {
    return null;
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export type ExportImportStatus =
  | 'idle'
  | 'exporting'
  | 'importing'
  | 'success'
  | 'error';

export interface UseChatExportImportReturn {
  status:        ExportImportStatus;
  lastSummary:   ImportSummary | null;
  lastError:     string | null;
  exportAll:     () => Promise<void>;
  exportSession: (sessionId: string) => Promise<void>;
  importFromFile:(options?: ImportOptions) => Promise<void>;
  importFromJson:(json: string, options?: ImportOptions) => Promise<void>;
  reset:         () => void;
}

export function useChatExportImport(
  repo:       ChatHistoryRepository,
  appVersion = '1.0.0',
): UseChatExportImportReturn {

  const [status,      setStatus]      = useState<ExportImportStatus>('idle');
  const [lastSummary, setLastSummary] = useState<ImportSummary | null>(null);
  const [lastError,   setLastError]   = useState<string | null>(null);

  const mountedRef = useRef(true);
  const exporter   = useRef(new ChatExportImport(repo)).current;

  const safe = useCallback(<T>(fn: () => T): T | undefined => {
    if (mountedRef.current) return fn();
    return undefined;
  }, []);

  // ── exportAll ──────────────────────────────────────────────────────────────
  const exportAll = useCallback(async () => {
    safe(() => { setStatus('exporting'); setLastError(null); });

    const result = await exporter.exportAll(appVersion);

    if (!result.ok) {
      safe(() => { setStatus('error'); setLastError(result.error.message); });
      return;
    }

    const filename = `chat-export-${Date.now()}.json`;
    const shared   = await shareText(result.data, filename);

    safe(() => setStatus(shared ? 'success' : 'error'));
    if (!shared) {
      safe(() => setLastError('Paylaşım başlatılamadı'));
    }
  }, [exporter, appVersion, safe]);

  // ── exportSession ──────────────────────────────────────────────────────────
  const exportSession = useCallback(async (sessionId: string) => {
    safe(() => { setStatus('exporting'); setLastError(null); });

    const result = await exporter.exportSession(sessionId, appVersion);

    if (!result.ok) {
      safe(() => { setStatus('error'); setLastError(result.error.message); });
      return;
    }

    const filename = `chat-${sessionId.slice(0, 8)}-${Date.now()}.json`;
    const shared   = await shareText(result.data, filename);

    safe(() => setStatus(shared ? 'success' : 'error'));
    if (!shared) safe(() => setLastError('Paylaşım başlatılamadı'));
  }, [exporter, appVersion, safe]);

  // ── importFromFile ─────────────────────────────────────────────────────────
  const importFromFile = useCallback(async (options?: ImportOptions) => {
    safe(() => { setStatus('importing'); setLastError(null); setLastSummary(null); });

    const json = await pickJsonFile();
    if (!json) {
      safe(() => setStatus('idle'));
      return;
    }

    const result = await exporter.importFrom(json, options);

    if (!result.ok) {
      safe(() => { setStatus('error'); setLastError(result.error.message); });
      return;
    }

    safe(() => { setStatus('success'); setLastSummary(result.data); });
  }, [exporter, safe]);

  // ── importFromJson (programatik) ───────────────────────────────────────────
  const importFromJson = useCallback(async (
    json:    string,
    options?: ImportOptions,
  ) => {
    safe(() => { setStatus('importing'); setLastError(null); setLastSummary(null); });

    const result = await exporter.importFrom(json, options);

    if (!result.ok) {
      safe(() => { setStatus('error'); setLastError(result.error.message); });
      return;
    }

    safe(() => { setStatus('success'); setLastSummary(result.data); });
  }, [exporter, safe]);

  const reset = useCallback(() => {
    safe(() => { setStatus('idle'); setLastError(null); setLastSummary(null); });
  }, [safe]);

  return {
    status,
    lastSummary,
    lastError,
    exportAll,
    exportSession,
    importFromFile,
    importFromJson,
    reset,
  };
}
