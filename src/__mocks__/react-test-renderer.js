// src/__mocks__/react-test-renderer.js
module.exports = {
  create: () => ({
    toJSON: () => null,
    update: () => {},
    unmount: () => {},
    root: {
      find: () => null,
      findAll: () => [],
      findByType: () => null,
      findAllByType: () => [],
    },
  }),
  act: (callback) => callback(),
};
