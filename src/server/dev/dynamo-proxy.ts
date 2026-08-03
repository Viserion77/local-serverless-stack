import http from 'http';
import { getBindHost } from '../services/bind-host.js';

// Temporary DynamoDB proxy: forwards http://localhost:8000 -> the engine (e.g., http://localhost:14566)
// Controlled by ENABLE_DYNAMO_PROXY env var; remove when no longer needed.
export function startDynamoProxy(targetEndpoint: string, port = 8000) {
  const targetBase = targetEndpoint.replace(/\/$/, '');

  const server = http.createServer((req, res) => {
    /* istanbul ignore next: Node's http server always populates req.url; defensive guard only */
    if (!req.url) {
      res.statusCode = 400;
      res.end('Bad Request');
      return;
    }

    const url = `${targetBase}${req.url}`;
    /* istanbul ignore next: req.headers is always populated by Node's http server */
    const headers = { ...(req.headers || {}) } as http.OutgoingHttpHeaders;
    delete (headers as any)['host'];

    const upstream = http.request(
      url,
      {
        method: req.method,
        headers,
      },
      upstreamRes => {
        /* istanbul ignore next: a real upstream response always carries a statusCode */
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers as http.OutgoingHttpHeaders);
        upstreamRes.pipe(res);
      },
    );

    upstream.on('error', err => {
      console.error('Proxy error:', err);
      /* istanbul ignore next: headers are not yet sent when the upstream connection fails */
      if (!res.headersSent) res.writeHead(502);
      res.end('Bad Gateway');
    });

    req.pipe(upstream);
  });

  // Same bind host as every other listener (services/bind-host.ts). This is a
  // credential-free, unauthenticated pass-through to the engine's DynamoDB
  // surface, so a bare `listen(port)` — which binds `::` — republished every
  // table on the network the moment `enableDynamoProxy` was turned on, however
  // carefully the orchestrator itself was fenced.
  server.listen(port, getBindHost(), () => {
    console.log(`✅ DynamoDB proxy listening on http://localhost:${port} -> ${targetBase}`);
  });

  // The proxy is an optional convenience: a busy port must degrade to a warning,
  // never take the orchestrator down with an unhandled 'error' event.
  server.on('error', (error: NodeJS.ErrnoException) => {
    const detail = error.code === 'EADDRINUSE'
      ? `port ${port} is already in use — set dynamoProxyPort to a free port or disable enableDynamoProxy`
      : error.message;
    console.warn(`⚠️  DynamoDB proxy disabled: ${detail}`);
  });

  return server;
}
