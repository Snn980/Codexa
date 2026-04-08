/**
 * features/editor/components/CodeMirrorEditor.tsx
 *
 * CM6 WebView köprüsü — CodeEditorRef arayüzünü tam uygular.
 *
 * ── Mimari ────────────────────────────────────────────────────────────────
 *  ┌─ React Native ─────────────────────────────────────────────────────────┐
 *  │  CodeMirrorEditor                                                      │
 *  │    ├── WebView (react-native-webview)                                  │
 *  │    │     └── CM6 (esm.sh CDN → WebView önbellek)                      │
 *  │    ├── pendingQueue → READY öncesi işlemler biriktirilir               │
 *  │    └── internalContent → feedback loop önleme                         │
 *  └────────────────────────────────────────────────────────────────────────┘
 *
 * ── Feedback Loop Önleme ─────────────────────────────────────────────────
 *  Kullanıcı CM6'da yazar → CHANGE mesajı → onChange() → prop güncellenir
 *  → content prop CM6'ya gönderilmez (internalContentRef ile kıyaslanır)
 *  → Döngü oluşmaz.
 *
 * ── Kurulum ───────────────────────────────────────────────────────────────
 *  expo install react-native-webview
 *
 * § 8  : React.memo + useRef
 * § 4  : AppContainer bağımsız — useTheme() kullanır
 */

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';

import { buildCm6Html }  from '../codemirror/cm6Html';
import { toCm6LangId }   from '../codemirror/languageMap';
import { useTheme }      from '@/theme';

// ─── Ref API — buradan export edilir, CodeEditor.tsx buradan alır ─────────────

export interface CodeEditorRef {
  focus:          () => void;
  blur:           () => void;
  clear:          () => void;
  insertAtCursor: (text: string) => void;
  moveCursor:     (dir: 'left' | 'right' | 'up' | 'down') => void;
}

// ─── Props ───────────────────────────────────────────────────────────────────

export interface CodeMirrorEditorProps {
  content:          string;
  language:         string;     // editor.logic.ts'den gelen dil adı
  readOnly:         boolean;
  fontSize?:        number;
  onChange:         (content: string) => void;
  onFocus?:         () => void;
  onBlur?:          () => void;
  onCursorChange?:  (line: number, col: number) => void;
  onReady?:         () => void;
}

// ─── WebView → RN mesaj tipleri ───────────────────────────────────────────────

type WvMessage =
  | { type: 'READY' }
  | { type: 'CHANGE'; content: string }
  | { type: 'CURSOR'; line: number; col: number }
  | { type: 'FOCUS' }
  | { type: 'BLUR' }
  | { type: 'ERROR'; message: string };

// ─── CodeMirrorEditor ─────────────────────────────────────────────────────────

export const CodeMirrorEditor = forwardRef<CodeEditorRef, CodeMirrorEditorProps>(
  (
    {
      content,
      language,
      readOnly,
      fontSize = 14,
      onChange,
      onFocus,
      onBlur,
      onCursorChange,
      onReady,
    },
    ref,
  ) => {
    const { colors }      = useTheme();
    const webViewRef      = useRef<WebView>(null);
    const isReadyRef      = useRef(false);
    const pendingQueue    = useRef<string[]>([]);

    // Feedback loop önleme: CM6'dan gelen son içerik burada tutulur.
    // content prop === internalContent ise CM6'ya tekrar gönderilmez.
    const internalContent = useRef<string>(content);
    const internalLang    = useRef<string>(language);

    const [isReady, setIsReady] = useState(false);

    // ── CM6 HTML — yalnızca ilk render'da oluşturulur ─────────────────────────
    const htmlSource = useRef(
      buildCm6Html({
        content,
        language: toCm6LangId(language),
        dark:     true,           // Uygulama her zaman dark tema
        fontSize,
        readOnly,
      }),
    );

    // ── JS enjeksiyonu ────────────────────────────────────────────────────────

    /**
     * CM6 köprü metodunu çağırır.
     * READY gelmeden önce kuyrukta biriktirilir.
     */
    const inject = useCallback((code: string) => {
      const js = '(function(){' + code + '; return true;})();';
      if (!isReadyRef.current) {
        pendingQueue.current.push(js);
        return;
      }
      webViewRef.current?.injectJavaScript(js);
    }, []);

    // ── Kuyruğu boşalt ───────────────────────────────────────────────────────

    const flushQueue = useCallback(() => {
      isReadyRef.current = true;
      const queue = pendingQueue.current;
      pendingQueue.current = [];
      queue.forEach((js) => webViewRef.current?.injectJavaScript(js));
    }, []);

    // ── Imperative API (CodeEditorRef) ────────────────────────────────────────

    useImperativeHandle(ref, () => ({
      focus: () => inject('window._cm.focus()'),
      blur:  () => inject('window._cm.blur()'),
      clear: () => {
        internalContent.current = '';
        inject('window._cm.setContent("","text")');
      },
      insertAtCursor: (text: string) => {
        inject('window._cm.insertText(' + JSON.stringify(text) + ')');
      },
      moveCursor: (dir: 'left' | 'right' | 'up' | 'down') => {
        inject('window._cm.moveCursor(' + JSON.stringify(dir) + ')');
      },
    }), [inject]);

    // ── WebView mesaj işleyici ────────────────────────────────────────────────

    const handleMessage = useCallback((e: WebViewMessageEvent) => {
      let msg: WvMessage;
      try { msg = JSON.parse(e.nativeEvent.data) as WvMessage; }
      catch { return; }

      switch (msg.type) {
        case 'READY': {
          setIsReady(true);
          flushQueue();
          onReady?.();
          break;
        }
        case 'CHANGE': {
          const newContent = msg.content;
          internalContent.current = newContent;
          onChange(newContent);
          break;
        }
        case 'CURSOR': {
          onCursorChange?.(msg.line, msg.col);
          break;
        }
        case 'FOCUS': {
          onFocus?.();
          break;
        }
        case 'BLUR': {
          onBlur?.();
          break;
        }
        case 'ERROR': {
          if (__DEV__) console.error('[CodeMirrorEditor] CM6 error:', msg.message);
          break;
        }
      }
    }, [flushQueue, onChange, onFocus, onBlur, onCursorChange, onReady]);

    // ── Content prop değişince CM6'ya gönder ─────────────────────────────────

    useEffect(() => {
      if (!isReady) return;
      if (content === internalContent.current) return; // feedback loop önle

      internalContent.current = content;
      inject('window._cm.setContent(' + JSON.stringify(content) + ',' + JSON.stringify(toCm6LangId(language)) + ')');
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [content, isReady]);

    // ── Dil prop değişince ────────────────────────────────────────────────────

    useEffect(() => {
      if (!isReady) return;
      if (language === internalLang.current) return;
      internalLang.current = language;
      inject('window._cm.setLanguage(' + JSON.stringify(toCm6LangId(language)) + ')');
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [language, isReady]);

    // ── Font boyutu değişince ─────────────────────────────────────────────────

    useEffect(() => {
      if (!isReady) return;
      inject('window._cm.setFontSize(' + fontSize + ')');
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fontSize, isReady]);

    // ── ReadOnly değişince ────────────────────────────────────────────────────

    useEffect(() => {
      if (!isReady) return;
      inject('window._cm.setReadOnly(' + (readOnly ? 'true' : 'false') + ')');
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [readOnly, isReady]);

    // ─────────────────────────────────────────────────────────────────────────

    return (
      <View style={[styles.container, { backgroundColor: colors.editor.bg }]}>
        <WebView
          ref={webViewRef}
          source={{ html: htmlSource.current, baseUrl: 'https://esm.sh' }}
          style={styles.webView}

          // ── Özellikler ───────────────────────────────────────────────────────
          javaScriptEnabled
          domStorageEnabled
          originWhitelist={['*']}
          // Android: CDN (HTTPS) kaynaklara izin ver
          mixedContentMode={Platform.OS === 'android' ? 'always' : undefined}
          // Önbellek — CDN modüllerini offline için sakla
          cacheEnabled
          cacheMode="LOAD_CACHE_ELSE_NETWORK"
          // Ölçeklendirme yok (viewport meta ile zaten engellendi)
          scalesPageToFit={false}
          // ── Olaylar ──────────────────────────────────────────────────────────
          onMessage={handleMessage}
          // Yükleme hatası
          onError={(e) => {
            if (__DEV__) console.error('[CodeMirrorEditor] WebView error:', e.nativeEvent);
          }}
          // Android arka plan — WebView'ın beyaz flash'ını önle
         
          // iOS performans
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
        />
      </View>
    );
  },
);

CodeMirrorEditor.displayName = 'CodeMirrorEditor';

// ─── Stiller ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  webView: {
    flex:            1,
    backgroundColor: 'transparent',
  },
});
