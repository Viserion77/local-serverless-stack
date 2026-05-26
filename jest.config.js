module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts', '**/*.test.js'],
  collectCoverageFrom: [
    'packages/*/src/**/*.{ts,js}',
    'packages/*/server/**/*.{ts,js}',
    'bin/**/*.js',
    '!**/*.d.ts',
    '!**/node_modules/**',
    '!**/dist/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  // The server uses NodeNext-style ESM imports with `.js` extensions in TS
  // source files (e.g. `import { Foo } from './foo.js'`). ts-jest doesn't
  // strip these on its own, so map them back to the TS source for tests.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testTimeout: 60000, // 60 seconds for integration tests
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  verbose: true,
  detectOpenHandles: true,
  forceExit: true,
};
