/**
 * features/editor/codemirror/cm6Html.ts
 *
 * CodeMirror 6 — WebView için kendi kendine yeten HTML şablonu.
 *
 * ── Yükleme Stratejisi ────────────────────────────────────────────────────
 *  CM6 paketleri esm.sh CDN'den yüklenir (ilk açılış internet gerektirir).
 *  Sonraki açılışlar WebView önbelleğinden gelir (offline çalışır).
 *  Üretim için: metro bundler ile inline bundle yapılabilir (bkz. README).
 *
 * ── Mesaj Protokolü ───────────────────────────────────────────────────────
 *  RN → WebView : webViewRef.injectJavaScript('window._cm.METHOD(ARGS); true;')
 *  WebView → RN : window.ReactNativeWebView.postMessage(JSON.stringify(msg))
 *
 * ── Köprü Metodları (RN → WebView) ───────────────────────────────────────
 *  window._cm.setContent(content: string, language: string)
 *  window._cm.setLanguage(language: string)
 *  window._cm.insertText(text: string)
 *  window._cm.moveCursor(dir: 'left'|'right'|'up'|'down')
 *  window._cm.setTheme(dark: boolean)
 *  window._cm.setFontSize(size: number)
 *  window._cm.setReadOnly(readOnly: boolean)
 *  window._cm.focus()
 *  window._cm.blur()
 *  window._cm.getContent() → string
 *
 * ── Mesajlar (WebView → RN) ───────────────────────────────────────────────
 *  { type: 'READY' }
 *  { type: 'CHANGE', content: string }
 *  { type: 'CURSOR', line: number, col: number }
 *  { type: 'FOCUS' }
 *  { type: 'BLUR' }
 *  { type: 'ERROR', message: string }
 */

export interface Cm6HtmlOptions {
  content:  string;
  language: string;
  dark:     boolean;
  fontSize: number;
  readOnly: boolean;
}

/**
 * Verilen seçeneklerle CM6 HTML sayfasını oluşturur.
 * Başlangıç değerleri <!--%%INIT%%--> yer tutucusu yerine enjekte edilir,
 * böylece şablondaki JS ile TypeScript şablon literali çakışmaz.
 */
export function buildCm6Html(opts: Cm6HtmlOptions): string {
  // JSON.stringify XSS/injection güvenli — </script> gibi diziler kaçırılır.
  const safeInit = JSON.stringify(opts).replace(/<\/script>/gi, '<\\/script>');
  const initTag  = '<script>window.__CM_INIT__=' + safeInit + ';<\/script>';
  return CM6_HTML.replace('<!--%%INIT%%-->', initTag);
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML Şablonu
//
// ÖNEMLİ: Bu template literal içinde ${...} kullanılmaz.
// Tüm JS kodu tek tırnak kullanır; backtick kesinlikle yok.
// Başlangıç değerleri yalnızca window.__CM_INIT__ üzerinden alınır.
// ─────────────────────────────────────────────────────────────────────────────
const CM6_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<!--%%INIT%%-->
<style>
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

  html, body {
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: #010409;
    -webkit-text-size-adjust: 100%;
    -webkit-tap-highlight-color: transparent;
  }

  #root { width: 100%; height: 100vh; }

  /* ── Yükleme göstergesi ────────────────────────────────────────────────── */
  #cm-loading {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    background: #010409;
    color: #6e7681;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px;
    z-index: 100;
    transition: opacity 0.25s ease;
  }
  #cm-loading .dot-row { display: flex; gap: 6px; }
  #cm-loading .dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: #388bfd;
    animation: bounce 1.2s ease-in-out infinite;
  }
  #cm-loading .dot:nth-child(2) { animation-delay: 0.2s; }
  #cm-loading .dot:nth-child(3) { animation-delay: 0.4s; }
  @keyframes bounce {
    0%, 80%, 100% { transform: scale(0.7); opacity: 0.5; }
    40%           { transform: scale(1.0); opacity: 1.0; }
  }
  #cm-loading.hidden { opacity: 0; pointer-events: none; }

  /* ── Hata ekranı ──────────────────────────────────────────────────────── */
  #cm-error {
    position: fixed;
    inset: 0;
    display: none;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    background: #010409;
    color: #f85149;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px;
    padding: 24px;
    text-align: center;
    z-index: 101;
  }
  #cm-error.show { display: flex; }
  #cm-error .hint { color: #6e7681; font-size: 11px; margin-top: 4px; }

  /* ── CodeMirror genel ─────────────────────────────────────────────────── */
  .cm-editor {
    height: 100vh;
    background: #010409;
  }
  .cm-editor.cm-focused { outline: none !important; }

  .cm-scroller {
    overflow: auto !important;
    -webkit-overflow-scrolling: touch;
    font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'SF Mono',
                 Menlo, Monaco, 'Courier New', monospace;
  }

  /* Satır içeriği */
  .cm-content {
    padding: 6px 0 120px;
    caret-color: #79c0ff;
    word-break: break-all;
  }
  .cm-line { padding: 0 16px 0 0; }

  /* Gutter (satır numaraları) */
  .cm-gutters {
    background: #010409 !important;
    border-right: 1px solid #161b22 !important;
    user-select: none;
    -webkit-user-select: none;
    min-width: 44px;
  }
  .cm-lineNumbers .cm-gutterElement {
    padding: 0 10px 0 6px;
    color: #484f58;
    min-width: 44px;
    text-align: right;
  }
  .cm-foldGutter .cm-gutterElement {
    cursor: pointer;
    color: #484f58;
    padding: 0 4px;
  }
  .cm-foldGutter .cm-gutterElement:hover { color: #8b949e; }

  /* Aktif satır */
  .cm-activeLine { background: rgba(121, 192, 255, 0.05) !important; }
  .cm-activeLineGutter {
    background: rgba(121, 192, 255, 0.05) !important;
    color: #8b949e !important;
  }

  /* İmleç */
  .cm-cursor { border-left: 2px solid #79c0ff !important; }

  /* Seçim */
  .cm-selectionBackground { background: rgba(56, 139, 253, 0.28) !important; }
  .cm-focused .cm-selectionBackground { background: rgba(56, 139, 253, 0.38) !important; }

  /* Parantez eşleştirme */
  .cm-matchingBracket {
    background: rgba(56, 139, 253, 0.22) !important;
    outline: 1px solid rgba(56, 139, 253, 0.45);
    border-radius: 2px;
  }
  .cm-nonmatchingBracket {
    background: rgba(248, 81, 73, 0.22) !important;
    outline: 1px solid rgba(248, 81, 73, 0.45);
    border-radius: 2px;
  }

  /* Otomatik tamamlama tooltip */
  .cm-tooltip {
    background: #161b22 !important;
    border: 1px solid #30363d !important;
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  }
  .cm-tooltip-autocomplete > ul { border-radius: 6px; overflow: hidden; }
  .cm-tooltip-autocomplete > ul > li {
    padding: 4px 12px;
    font-size: 13px;
    color: #c9d1d9;
  }
  .cm-tooltip-autocomplete > ul > li[aria-selected] {
    background: #1f6feb !important;
    color: #fff;
  }

  /* Özel karakter highlight */
  .cm-specialChar { color: #ff7b72; }

  /* Kaydırma çubuğu */
  .cm-scroller::-webkit-scrollbar { width: 5px; height: 5px; }
  .cm-scroller::-webkit-scrollbar-track { background: transparent; }
  .cm-scroller::-webkit-scrollbar-thumb { background: #21262d; border-radius: 3px; }
  .cm-scroller::-webkit-scrollbar-thumb:hover { background: #30363d; }

  /* Search panel */
  .cm-panels { background: #161b22 !important; border-top: 1px solid #21262d !important; }
  .cm-searchMatch { background: rgba(255, 173, 26, 0.25); }
  .cm-searchMatch-selected { background: rgba(255, 173, 26, 0.5); }
</style>
</head>
<body>

<div id="cm-loading">
  <div class="dot-row">
    <div class="dot"></div>
    <div class="dot"></div>
    <div class="dot"></div>
  </div>
  <span>Editor yükleniyor…</span>
</div>

<div id="cm-error">
  <span id="cm-error-msg">Editör yüklenemedi</span>
  <span class="hint">İnternet bağlantısını kontrol edin</span>
</div>

<div id="root"></div>

<script type="module">
'use strict';

// ── RN köprü yardımcısı ──────────────────────────────────────────────────────
function postRN(data) {
  try {
    var s = JSON.stringify(data);
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(s);
    } else {
      console.log('[CM6→RN]', data);
    }
  } catch (e) { /* ignore */ }
}

// ── Yükleme UI ───────────────────────────────────────────────────────────────
function hideLoading() {
  var el = document.getElementById('cm-loading');
  if (!el) return;
  el.classList.add('hidden');
  setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
}

function showError(msg) {
  hideLoading();
  var wrap = document.getElementById('cm-error');
  var msgEl = document.getElementById('cm-error-msg');
  if (wrap && msgEl) { msgEl.textContent = msg; wrap.classList.add('show'); }
  postRN({ type: 'ERROR', message: msg });
}

// ── Başlangıç konfigürasyonu ─────────────────────────────────────────────────
var CFG = window.__CM_INIT__ || {
  content: '', language: 'text', dark: true, fontSize: 14, readOnly: false,
};

// ── CDN ──────────────────────────────────────────────────────────────────────
var ESM = 'https://esm.sh';

// ── Ana başlatma fonksiyonu ─────────────────────────────────────────────────
async function boot() {
  try {
    // ── Modül yükleme — paralel ───────────────────────────────────────────────
    var mods = await Promise.all([
      import(ESM + '/@codemirror/view@6'),
      import(ESM + '/@codemirror/state@6'),
      import(ESM + '/@codemirror/commands@6'),
      import(ESM + '/@codemirror/language@6'),
      import(ESM + '/@codemirror/autocomplete@6'),
      import(ESM + '/@codemirror/theme-one-dark@6'),
      import(ESM + '/@codemirror/search@6'),
      import(ESM + '/@codemirror/lang-javascript@6'),
      import(ESM + '/@codemirror/lang-python@6'),
      import(ESM + '/@codemirror/lang-html@6'),
      import(ESM + '/@codemirror/lang-css@6'),
      import(ESM + '/@codemirror/lang-json@6'),
      import(ESM + '/@codemirror/lang-markdown@6'),
    ]);

    var viewMod   = mods[0];
    var stateMod  = mods[1];
    var cmdMod    = mods[2];
    var langMod   = mods[3];
    var autoMod   = mods[4];
    var darkMod   = mods[5];
    var searchMod = mods[6];
    var jsLang    = mods[7];
    var pyLang    = mods[8];
    var htmlLang  = mods[9];
    var cssLang   = mods[10];
    var jsonLang  = mods[11];
    var mdLang    = mods[12];

    // ── Paketlerden al ────────────────────────────────────────────────────────
    var EditorView           = viewMod.EditorView;
    var lineNumbers          = viewMod.lineNumbers;
    var highlightActiveLine  = viewMod.highlightActiveLine;
    var keymap               = viewMod.keymap;
    var drawSelection        = viewMod.drawSelection;
    var dropCursor           = viewMod.dropCursor;
    var highlightSpecialChars= viewMod.highlightSpecialChars;
    var placeholder          = viewMod.placeholder;

    var EditorState          = stateMod.EditorState;
    var Compartment          = stateMod.Compartment;

    var defaultKeymap        = cmdMod.defaultKeymap;
    var historyKeymap        = cmdMod.historyKeymap;
    var history              = cmdMod.history;
    var indentWithTab        = cmdMod.indentWithTab;
    var cursorCharLeft       = cmdMod.cursorCharLeft;
    var cursorCharRight      = cmdMod.cursorCharRight;
    var cursorLineUp         = cmdMod.cursorLineUp;
    var cursorLineDown       = cmdMod.cursorLineDown;

    var syntaxHighlighting   = langMod.syntaxHighlighting;
    var defaultHighlightStyle= langMod.defaultHighlightStyle;
    var bracketMatching      = langMod.bracketMatching;
    var foldGutter           = langMod.foldGutter;
    var indentOnInput        = langMod.indentOnInput;

    var closeBrackets        = autoMod.closeBrackets;
    var closeBracketsKeymap  = autoMod.closeBracketsKeymap;
    var autocompletion       = autoMod.autocompletion;
    var completionKeymap     = autoMod.completionKeymap;

    var oneDark              = darkMod.oneDark;

    var searchKeymap         = searchMod.searchKeymap;
    var search               = searchMod.search;

    // ── Dil haritası ─────────────────────────────────────────────────────────
    function getLangExt(lang) {
      switch (lang) {
        case 'javascript': return jsLang.javascript({ jsx: false });
        case 'jsx':        return jsLang.javascript({ jsx: true });
        case 'typescript': return jsLang.javascript({ typescript: true, jsx: false });
        case 'tsx':        return jsLang.javascript({ typescript: true, jsx: true });
        case 'python':     return pyLang.python();
        case 'html':       return htmlLang.html({ matchClosingTags: true, autoCloseTags: true });
        case 'css':        return cssLang.css();
        case 'json':       return jsonLang.json();
        case 'markdown':   return mdLang.markdown();
        default:           return [];
      }
    }

    // ── Tema yardımcısı ───────────────────────────────────────────────────────
    function makeTheme(dark) {
      return dark ? oneDark : syntaxHighlighting(defaultHighlightStyle);
    }

    // ── Font boyutu teması ────────────────────────────────────────────────────
    function makeFontTheme(size) {
      return EditorView.theme({
        '.cm-content':  { fontSize: size + 'px', lineHeight: (size * 1.65) + 'px' },
        '.cm-gutter':   { fontSize: (size - 1) + 'px', lineHeight: (size * 1.65) + 'px' },
        '.cm-scroller': { fontSize: size + 'px' },
      });
    }

    // ── Compartment'lar — dinamik güncelleme için ─────────────────────────────
    var langComp     = new Compartment();
    var themeComp    = new Compartment();
    var readOnlyComp = new Compartment();
    var fontComp     = new Compartment();

    // ── Son içerik (feedback loop önleme) ────────────────────────────────────
    var lastSentContent = CFG.content;

    // ── Editor oluştur ────────────────────────────────────────────────────────
    var view = new EditorView({
      state: EditorState.create({
        doc: CFG.content,
        extensions: [
          // Temel
          lineNumbers(),
          foldGutter(),
          highlightActiveLine(),
          highlightSpecialChars(),
          drawSelection(),
          dropCursor(),
          indentOnInput(),
          placeholder('Yazmaya başlayın…'),

          // Tarih (geri al / ileri al)
          history(),

          // Parantez
          bracketMatching(),
          closeBrackets(),

          // Otomatik tamamlama
          autocompletion(),

          // Arama
          search({ top: false }),

          // Tuş haritaları
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...completionKeymap,
            ...searchKeymap,
            indentWithTab,
          ]),

          // Uzun satır kırmı (mobil için kritik)
          EditorView.lineWrapping,

          // Dinamik compartment'lar
          langComp.of(getLangExt(CFG.language)),
          themeComp.of(makeTheme(CFG.dark)),
          readOnlyComp.of(EditorState.readOnly.of(CFG.readOnly)),
          fontComp.of(makeFontTheme(CFG.fontSize)),

          // Değişiklik dinleyici
          EditorView.updateListener.of(function(upd) {
            if (upd.docChanged) {
              var newContent = upd.state.doc.toString();
              if (newContent !== lastSentContent) {
                lastSentContent = newContent;
                postRN({ type: 'CHANGE', content: newContent });
              }
            }
            if (upd.selectionSet || upd.docChanged) {
              var anchor = upd.state.selection.main.anchor;
              var line   = upd.state.doc.lineAt(anchor);
              postRN({ type: 'CURSOR', line: line.number, col: anchor - line.from + 1 });
            }
          }),

          // Focus / blur olayları
          EditorView.domEventHandlers({
            focus: function() { postRN({ type: 'FOCUS' }); return false; },
            blur:  function() { postRN({ type: 'BLUR' });  return false; },
          }),
        ],
      }),
      parent: document.getElementById('root'),
    });

    // ── Köprü nesnesi — RN tarafından injectJavaScript ile çağrılır ──────────
    window._cm = {
      /** İçerik + dil değişimi */
      setContent: function(content, lang) {
        lastSentContent = content;
        var effects = [langComp.reconfigure(getLangExt(lang || CFG.language))];
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: content },
          effects: effects,
        });
      },

      /** Yalnızca dil değişimi (içerik korunur) */
      setLanguage: function(lang) {
        view.dispatch({ effects: langComp.reconfigure(getLangExt(lang)) });
      },

      /** Cursor'a metin ekle */
      insertText: function(text) {
        var sel = view.state.selection.main;
        view.dispatch({
          changes:   { from: sel.from, to: sel.to, insert: text },
          selection: { anchor: sel.from + text.length },
          scrollIntoView: true,
        });
        view.focus();
      },

      /** Cursor taşı */
      moveCursor: function(dir) {
        if (dir === 'left')  cursorCharLeft(view);
        if (dir === 'right') cursorCharRight(view);
        if (dir === 'up')    cursorLineUp(view);
        if (dir === 'down')  cursorLineDown(view);
        view.focus();
      },

      /** Tema değiştir */
      setTheme: function(dark) {
        view.dispatch({ effects: themeComp.reconfigure(makeTheme(dark)) });
      },

      /** Font boyutu */
      setFontSize: function(size) {
        view.dispatch({ effects: fontComp.reconfigure(makeFontTheme(size)) });
      },

      /** Sadece okunur mod */
      setReadOnly: function(ro) {
        view.dispatch({ effects: readOnlyComp.reconfigure(EditorState.readOnly.of(ro)) });
      },

      /** Focus / blur */
      focus: function() { view.focus(); },
      blur:  function() { view.contentDOM.blur(); },

      /** Mevcut içeriği al */
      getContent: function() { return view.state.doc.toString(); },
    };

    // ── Hazır ────────────────────────────────────────────────────────────────
    hideLoading();
    postRN({ type: 'READY' });

  } catch (err) {
    var msg = err && err.message ? err.message : String(err);
    showError('CM6 yüklenemedi: ' + msg);
  }
}

boot();
</script>
</body>
</html>`;
