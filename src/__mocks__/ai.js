/**
 * __mocks__/ai.js — Vercel AI SDK mock
 *
 * streamText her çağrıda taze AsyncIterable döndürür.
 * async function* KULLANILMAZ — Symbol.asyncIterator kullanılır.
 */
'use strict';

function makeTextStream(chunks) {
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
      };
    },
  };
}

module.exports = {
  streamText: jest.fn().mockImplementation(function() {
    return { textStream: makeTextStream(['Hello', ' world']) };
  }),
  generateText: jest.fn().mockResolvedValue({ text: 'Hello world' }),
};
