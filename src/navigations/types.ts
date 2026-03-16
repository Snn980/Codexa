/**
 * src/navigations/types.ts
 *
 * React Navigation v7 parametre tipleri.
 * § 9  : React Navigation v7 — Bottom Tabs + Native Stack
 * § 32 : NavigationErrorBoundary | safeNavigate | nav:error event
 * § 39 : Deep link — aiide://chat/:sessionId
 * § 62 : TerminalTab eklendi — aiide://terminal
 */

// ─── Tab Navigator ─────────────────────────────────────────────────────────────

export type TabParamList = {
  ChatTab:     undefined;
  EditorTab:   undefined;
  ModelsTab:   undefined;
  /** § 62 — Runtime terminal tab */
  TerminalTab: undefined;
  SettingsTab: undefined;
};

// ─── Chat Stack ───────────────────────────────────────────────────────────────

export type ChatStackParamList = {
  AIChat: {
    /** § 39: Deep link aiide://chat/:sessionId */
    sessionId?: string;
  };
  ModelDownload: undefined;
};

// ─── Editor Stack ─────────────────────────────────────────────────────────────

export type EditorStackParamList = {
  EditorMain: {
    /** Açılacak dosyanın URI'si — opsiyonel */
    fileUri?: string;
  };
  AIPanel: {
    sessionId: string;
  };
};
