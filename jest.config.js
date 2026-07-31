// Unit test config (the default `jest` run): fast, hermetic, no Docker.
// Enforces a 100% coverage gate on the unit-testable server code. The
// integration suite has its own config (jest.integration.config.js).
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests/unit'],
  testMatch: ['**/*.test.ts', '**/*.test.js'],
  collectCoverageFrom: [
    'src/server/services/**/*.ts',
    'src/server/routes/**/*.ts',
    'src/server/dev/**/*.ts',
    'src/client/**/*.ts',
    'src/mcp/**/*.ts',
    'bin/cli.js',
    // Integration-only by nature — excluded from the coverage denominator:
    '!src/server/index.ts', // calls start()/listens at import
    '!src/server/services/localstack-manager.ts', // drives Docker
    '!src/server/services/lambda-runtime-manager.ts', // forks runtime workers
    '!src/server/services/gateway-manager.ts', // binds real HTTP listeners
    '!src/server/services/source-watcher.ts', // drives fs.watch
    '!src/server/services/service-registrar.ts', // end-to-end registration flow: packaging + provisioning + data plane
    '!**/*.d.ts',
    '!**/node_modules/**',
    '!**/dist/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  coverageThreshold: {
    global: { branches: 100, functions: 100, lines: 100, statements: 100 },
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  // The server uses NodeNext-style ESM imports with `.js` extensions in TS
  // source files (e.g. `import { Foo } from './foo.js'`). ts-jest doesn't
  // strip these on its own, so map them back to the TS source for tests.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testTimeout: 10000,
  setupFilesAfterEnv: ['<rootDir>/tests/setup.unit.ts'],
  verbose: true,
};
