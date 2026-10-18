// Fixture for the forked runtime-worker test: reports the env the invocation
// ran with, so the per-invocation env reset can be asserted.
exports.handler = async () => ({
  table: process.env.TABLE_NAME ?? null,
  endpoint: process.env.AWS_ENDPOINT_URL ?? null,
  baseline: process.env.LSS_FIXTURE_BASELINE ?? null,
});
