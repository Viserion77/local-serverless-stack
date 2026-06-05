// Shared custom Jest matchers + type augmentation. Imported by both the unit
// and integration setup files so the matchers (and their types) are available
// in every test, while the heavy lifecycle stays integration-only.

expect.extend({
  toBeValidPort(received: number) {
    const pass = received > 0 && received < 65536;
    return {
      pass,
      message: () => `expected ${received} to be a valid port (1-65535)`,
    };
  },

  toBeValidPid(received: number) {
    const pass = received > 0;
    return {
      pass,
      message: () => `expected ${received} to be a valid PID (> 0)`,
    };
  },
});

// Extend Jest matchers type
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    interface Matchers<R> {
      toBeValidPort(): R;
      toBeValidPid(): R;
    }
  }
}

export {};
