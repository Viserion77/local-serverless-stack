exports.handler = async () => ({
  statusCode: 200,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ok: true, service: 'sample-microservice', ts: Date.now() }),
});
