// A TypeScript entry: needs a loader (or native type stripping) to start.
import http from 'node:http';

const endpoint: string = process.env.AWS_LAMBDA_HTTP_ENDPOINT as string;
const [host, port] = endpoint.split(':');
http.createServer((_req, res) => res.end('typed hello')).listen(Number(port), host);
