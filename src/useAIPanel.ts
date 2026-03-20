/**
 * src/useAIPanel.ts — Geriye dönük uyumluluk barrel.
 *
 * Canonical konum: src/hooks/useAIPanel.ts
 * Bu dosya eski import path'lerini kırmadan çalışmaya devam ettirir.
 *
 * REFACTOR: Duplike implementasyon kaldırıldı; 'as never' cast'leri temizlendi.
 */
export { useAIPanel } from './hooks/useAIPanel';
export type {
  UseAIPanelOptions,
  UseAIPanelReturn,
  ActiveFileContext,
} from './hooks/useAIPanel';
