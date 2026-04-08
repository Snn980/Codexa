/**
 * __mocks__/libtermexec.ts
 * Jest mock — native PTY test ortamında çalışmaz.
 *
 * Projeye kopyalanacak yer: src/__mocks__/libtermexec.ts
 */

export const TermExecModule = {
  createSession:   jest.fn().mockReturnValue('mock-session-id'),
  writeInput:      jest.fn(),
  resizeTerminal:  jest.fn(),
  killSession:     jest.fn(),
  closeSession:    jest.fn(),
  listSessions:    jest.fn().mockReturnValue([]),
  onData:          jest.fn(),
  onExit:          jest.fn(),
  onError:         jest.fn(),
};

export const useTermExec = jest.fn().mockReturnValue({
  lines:       [],
  isRunning:   false,
  sessionId:   null,
  isSupported: true,
  start:       jest.fn(),
  stop:        jest.fn(),
  sendInput:   jest.fn(),
  resize:      jest.fn(),
  clear:       jest.fn(),
});
