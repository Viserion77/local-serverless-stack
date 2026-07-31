// Integration test config: boots a real isolated LSS on the self engine.
// No coverage gate; long timeouts. Run with `npm run test:integration`.
// No Docker and no auth token — it runs on any machine and in any CI job.
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
  // Each suite binds real ports (orchestrator, engine, per-service listeners),
  // so they must not overlap. Run serially.
  maxWorkers: 1,
  setupFilesAfterEnv: ['<rootDir>/tests/setup.integration.ts'],
  verbose: true,
  detectOpenHandles: true,
  forceExit: true,
};
