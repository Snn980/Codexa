/**
 * __mocks__/@react-native-ai/mlc.js
 *
 * Global Jest mock — native modül test ortamında çalışmaz.
 *
 * FIX: async function* KULLANILMAZ.
 * Babel _wrapAsyncGenerator factory içinde dışa referans oluşturur → Jest hoisting kırılır.
 * Çözüm: Symbol.asyncIterator protokolü — saf JS nesnesi, Babel dönüşümü yok.
 */
'use strict';

function makeAsyncTextStream(chunks) {
  let i = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (i < chunks.length) {
            return Promise.resolve({ value: chunks[i++], done: false });
          }
          return Promise.resolve({ value: undefined, done: true });
        },
        return() {
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

function makeModel() {
  return {
    specificationVersion: 'v1',
    provider: 'mlc',
    modelId: 'test-model',
    doStream: jest.fn().mockResolvedValue({ stream: makeAsyncTextStream(['Hello', ' world']) }),
    doGenerate: jest.fn().mockResolvedValue({ text: 'Hello world' }),
    download: jest.fn().mockImplementation((onProgress) => {
      if (onProgress) onProgress({ percentage: 100, receivedMB: 1, totalMB: 1 });
      return Promise.resolve();
    }),
    prepare: jest.fn().mockResolvedValue(undefined),
    unload: jest.fn().mockResolvedValue(undefined),
  };
}

module.exports = {
  mlc: {
    languageModel: jest.fn().mockImplementation(function(_modelId) {
      return makeModel();
    }),
  },
};
