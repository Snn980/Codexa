/**
 * features/editor/codemirror/languageMap.ts
 *
 * editor.logic.ts'den gelen dil adlarını CM6 HTML'nin beklediği
 * dil kimliklerine dönüştürür.
 *
 * CM6 HTML desteklenen dil kimlikleri:
 *   'javascript' | 'jsx' | 'typescript' | 'tsx'
 *   'python' | 'html' | 'css' | 'json' | 'markdown' | 'text'
 */

/** CM6 HTML'nin tanıdığı dil kimlikleri */
export type Cm6LangId =
  | 'javascript'
  | 'jsx'
  | 'typescript'
  | 'tsx'
  | 'python'
  | 'html'
  | 'css'
  | 'json'
  | 'markdown'
  | 'text';

/** Uygulama dil adı → CM6 dil kimliği */
export function toCm6LangId(appLang: string): Cm6LangId {
  switch (appLang.toLowerCase()) {
    case 'javascript': return 'javascript';
    case 'jsx':        return 'jsx';
    case 'typescript': return 'typescript';
    case 'tsx':        return 'tsx';
    case 'python':     return 'python';
    case 'html':       return 'html';
    case 'css':        return 'css';
    case 'json':       return 'json';
    case 'markdown':   return 'markdown';
    // Şu an CM6 paketi dahil edilmemiş diller (gelecek sürüm için)
    case 'java':       return 'text'; // TODO: @codemirror/lang-java
    case 'cpp':
    case 'c':          return 'text'; // TODO: @codemirror/lang-cpp
    case 'rust':       return 'text'; // TODO: @codemirror/lang-rust
    case 'go':         return 'text'; // TODO: @codemirror/lang-go
    default:           return 'text';
  }
}

/**
 * Kullanıcı dostu dil görüntüleme adı.
 * StatusBar'da gösterilir.
 */
export function getLangDisplayName(cm6Lang: Cm6LangId): string {
  const map: Record<Cm6LangId, string> = {
    javascript: 'JavaScript',
    jsx:        'JSX',
    typescript: 'TypeScript',
    tsx:        'TSX',
    python:     'Python',
    html:       'HTML',
    css:        'CSS',
    json:       'JSON',
    markdown:   'Markdown',
    text:       'Plain Text',
  };
  return map[cm6Lang] ?? 'Plain Text';
}
