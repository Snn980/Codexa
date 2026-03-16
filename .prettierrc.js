// .prettierrc.js
//
// Sorun: Prettier config yok → farklı editörlerde format uyumsuzluğu.
// Çözüm: React Native / TypeScript projeleri için standart ayarlar.

'use strict';

/** @type {import('prettier').Config} */
module.exports = {
  // Temel format
  printWidth:         100,
  tabWidth:           2,
  useTabs:            false,
  semi:               true,
  singleQuote:        true,
  quoteProps:         'as-needed',
  trailingComma:      'all',   // ES2017+ — async function params dahil
  bracketSpacing:     true,
  bracketSameLine:    false,   // JSX kapanış '>' yeni satırda
  arrowParens:        'always',
  endOfLine:          'lf',

  // TypeScript / JSX
  jsxSingleQuote:     false,

  // Dosya bazlı override
  overrides: [
    {
      files: ['*.json', '*.jsonc'],
      options: { printWidth: 80, tabWidth: 2 },
    },
    {
      files: ['*.md', '*.mdx'],
      options: { printWidth: 80, proseWrap: 'always' },
    },
    {
      files: ['*.yml', '*.yaml'],
      options: { tabWidth: 2, singleQuote: false },
    },
  ],
};
