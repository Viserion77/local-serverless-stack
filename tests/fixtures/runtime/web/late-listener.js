// Listens only after LATE_MS (default 9000 — just inside Lambda's 10 s).
const http = require('node:http');
const [host, port] = process.env.AWS_LAMBDA_HTTP_ENDPOINT.split(':');
setTimeout(() => {
  http.createServer((_req, res) => res.end('late but fine')).listen(Number(port), host);
}, Number(process.env.LATE_MS || 9000));
