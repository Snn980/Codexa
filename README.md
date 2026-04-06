# CodeMirror 6 WebView Entegrasyonu

## Kurulum

```bash
# 1. WebView paketini yükle
expo install react-native-webview

# 2. Expo Go ile test — kurulum sonrası direkt çalışır
npx expo start
```

## Mimari Özet

```
CodeEditor (public API — değişmedi)
  └── CodeMirrorEditor (WebView köprüsü)
        └── WebView
              └── CM6 HTML (esm.sh CDN)
                    ├── @codemirror/view
                    ├── @codemirror/state
                    ├── @codemirror/commands
                    ├── @codemirror/language
                    ├── @codemirror/autocomplete
                    ├── @codemirror/search
                    ├── @codemirror/theme-one-dark
                    └── lang-{javascript,python,html,css,json,markdown}
```

## Desteklenen Diller

| Uzantı | Dil ID | CM6 Paketi |
|--------|---------|------------|
| .js | javascript | @codemirror/lang-javascript |
| .jsx | jsx | @codemirror/lang-javascript |
| .ts | typescript | @codemirror/lang-javascript |
| .tsx | tsx | @codemirror/lang-javascript |
| .py | python | @codemirror/lang-python |
| .html | html | @codemirror/lang-html |
| .css | css | @codemirror/lang-css |
| .json | json | @codemirror/lang-json |
| .md | markdown | @codemirror/lang-markdown |

## Status Bar Entegrasyonu

EditorScreen'de cursor pozisyonunu almak için:

```tsx
// EditorScreen.tsx içinde
const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 });

<CodeEditor
  ref={codeEditorRef}
  // ... diğer props
  onCursorChange={(line, col) => setCursorPos({ line, col })}
/>

// StatusBar'a geç:
<StatusBar lineNumber={cursorPos.line} colNumber={cursorPos.col} />
```

## İlk Yükleme Performansı

| Senaryo | Süre |
|---------|------|
| İlk açılış (internet) | ~2-4s |
| Sonraki açılışlar (önbellek) | ~0.3-0.8s |
| Offline (önbellek dolu) | ~0.3-0.8s |

## Üretim İçin: Offline Bundle

CDN bağımlılığını kaldırmak için CM6'yı metro ile bundle edin:

```bash
# 1. CM6 paketlerini yükle
npm install @codemirror/view @codemirror/state @codemirror/commands \
            @codemirror/language @codemirror/autocomplete @codemirror/search \
            @codemirror/theme-one-dark \
            @codemirror/lang-javascript @codemirror/lang-python \
            @codemirror/lang-html @codemirror/lang-css \
            @codemirror/lang-json @codemirror/lang-markdown

# 2. esbuild ile bundle
npx esbuild src/features/editor/codemirror/cm6Bundle.entry.js \
  --bundle --format=esm --outfile=assets/cm6.bundle.js \
  --minify --tree-shaking=true

# 3. cm6Html.ts'de CDN yerine local bundle kullan
```

## Gelecek İyileştirmeler

- [ ] Go, Java, Rust, C++ dil desteği
- [ ] VS Code renk temasına geçiş
- [ ] Vim modu (@codemirror/vim)
- [ ] Çoklu imleç
- [ ] Kod katlama (fold gutter zaten aktif)
- [ ] LSP over HTTP (tanım, hover, rename)
- [ ] Diff görünümü (@codemirror/merge)
