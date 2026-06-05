// Integration test config: boots a real isolated LSS + LocalStack (Docker).
// No coverage gate; long timeouts. Run with `npm run test:integration`.
// Requires Docker and a LOCALSTACK_AUTH_TOKEN (community images >= 2026.5).
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests/integration'],
  testMatch: ['**/*.test.ts', '**/*.test.js'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testTimeout: 120000,
  setupFilesAfterEnv: ['<rootDir>/tests/setup.integration.ts'],
  verbose: true,
  detectOpenHandles: true,
  forceExit: true,
};
