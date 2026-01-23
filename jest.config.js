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
  testTimeout: 60000, // 60 seconds for integration tests
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  verbose: true,
  detectOpenHandles: true,
  forceExit: true,
};
