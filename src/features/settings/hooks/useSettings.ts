/**
 * @file  features/settings/hooks/useSettings.ts
 *
 * Settings feature — tüm state ve logic burada.
 * SettingsScreen sadece render eder.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAppContext }        from "@/app/AppContext";
import { DEFAULT_SETTINGS, AIProviderPreference, type ISettings } from "@/index";

export function useSettings() {
  const { services } = useAppContext();
  const { settingsRepository, keyStore, appStateMgr } = services;

  const [settings,     setSettings]     = useState<ISettings>(DEFAULT_SETTINGS);
  const [loading,      setLoading]      = useState(true);
  const [saving,       setSaving]       = useState(false);
  const [anthropicKey, setAnthropicKey] = useState("");
  const [openaiKey,    setOpenaiKey]    = useState("");
  const [keysSaved,    setKeysSaved]    = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void (async () => {
      const result = await settingsRepository.get();
      if (result.ok) setSettings(result.data);

      try {
        const ak = await keyStore.getKey("anthropic");
        const ok = await keyStore.getKey("openai");
        if (ak) setAnthropicKey(ak);
        if (ok) setOpenaiKey(ok);
      } catch { /* keyStore henüz hazır değilse atla */ }

      setLoading(false);
    })();

    return () => {
      // Sadece local kaynak temizlenir — service dispose edilmez
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [settingsRepository, keyStore]); // ← bağımlılıklar açık

  const save = useCallback((partial: Partial<ISettings>) => {
    setSettings(prev => ({ ...prev, ...partial }));

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setSaving(true);
      const result = await settingsRepository.set(partial);
      if (!result.ok) {
        const fresh = await settingsRepository.get();
        if (fresh.ok) setSettings(fresh.data);
      }
      setSaving(false);
    }, 350);
  }, [settingsRepository]);

  const reset = useCallback(async () => {
    setSaving(true);
    const result = await settingsRepository.reset();
    if (result.ok) setSettings(DEFAULT_SETTINGS);
    setSaving(false);
  }, [settingsRepository]);

  const saveKeys = useCallback(async () => {
    if (anthropicKey.trim()) {
      const r = await keyStore.setKey("anthropic", anthropicKey.trim());
      if (!r.ok) throw new Error(`Anthropic key kaydedilemedi: ${r.error?.message}`);
    }

    if (openaiKey.trim()) {
      const r = await keyStore.setKey("openai", openaiKey.trim());
      if (!r.ok) throw new Error(`OpenAI key kaydedilemedi: ${r.error?.message}`);
    }

    try { appStateMgr.simulateStateChange("active"); } catch { /* no-op */ }

    setKeysSaved(true);
    setTimeout(() => setKeysSaved(false), 2000);
  }, [anthropicKey, openaiKey, keyStore, appStateMgr]); // ← bağımlılıklar açık

  /** Provider preference'ı güncelle — debounce ile persist edilir. */
  const setProviderPreference = useCallback((pref: AIProviderPreference) => {
    save({ providerPreference: pref });
  }, [save]);

  return {
    settings,
    loading,
    saving,
    anthropicKey,
    openaiKey,
    keysSaved,
    setAnthropicKey,
    setOpenaiKey,
    save,
    reset,
    saveKeys,
    setProviderPreference,
  };
}
