// Shared HTTP response helper. Every response carries a permissive CORS header
// so the validation console (index.html) can call these routes straight from
// the browser; serverless-offline answers the preflight (cors: true per event).
module.exports = (statusCode, payload) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  },
  body: JSON.stringify(payload),
});
