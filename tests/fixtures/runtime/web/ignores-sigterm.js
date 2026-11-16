// Ignores SIGTERM: only the SIGKILL that follows 1 s later stops it.
const http = require('node:http');
const [host, port] = process.env.AWS_LAMBDA_HTTP_ENDPOINT.split(':');
http.createServer((_req, res) => res.end('stubborn')).listen(Number(port), host);
process.on('SIGTERM', () => console.log('SIGTERM ignored'));
