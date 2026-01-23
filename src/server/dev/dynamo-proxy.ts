import http from 'http';

// Temporary DynamoDB proxy: forwards http://localhost:8000 -> LocalStack (e.g., http://localhost:4566)
// Controlled by ENABLE_DYNAMO_PROXY env var; remove when no longer needed.
export function startDynamoProxy(targetEndpoint: string, port = 8000) {
  const targetBase = targetEndpoint.replace(/\/$/, '');

  const server = http.createServer((req, res) => {
    if (!req.url) {
      res.statusCode = 400;
      res.end('Bad Request');
      return;
    }

    const url = `${targetBase}${req.url}`;
    const headers = { ...(req.headers || {}) } as http.OutgoingHttpHeaders;
    delete (headers as any)['host'];

    const upstream = http.request(
      url,
      {
        method: req.method,
        headers,
      },
      upstreamRes => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers as http.OutgoingHttpHeaders);
        upstreamRes.pipe(res);
      },
    );

    upstream.on('error', err => {
      console.error('Proxy error:', err);
      if (!res.headersSent) res.writeHead(502);
      res.end('Bad Gateway');
    });

    req.pipe(upstream);
  });

  server.listen(port, () => {
    console.log(`✅ DynamoDB proxy listening on http://localhost:${port} -> ${targetBase}`);
  });

  return server;
}
