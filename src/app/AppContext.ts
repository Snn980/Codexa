/**
 * @file  app/AppContext.ts
 *
 * Servis enjeksiyonu için React context.
 * App.tsx'teki AppContext + useAppContext buraya taşındı.
 *
 * Sorumluluk: servisleri React ağacına enjekte etmek.
 */

import { createContext, useContext } from "react";
import type { AppServices } from "@/index";

// ─── Context ─────────────────────────────────────────────────────────────────

export interface AppContextValue {
  readonly services: AppServices;
}

export const AppContext = createContext<AppContextValue | null>(null);

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useAppContext(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error(
      "[useAppContext] AppContext bulunamadı. Bileşen <App /> altında olmalı.",
    );
  }
  return ctx;
}
