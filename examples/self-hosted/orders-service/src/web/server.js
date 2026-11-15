// orders-web — a Lambda Web Function written on plain `node:http`.
//
// No handler signature, no event-to-HTTP adapter: this is an ordinary HTTP
// server. Lambda (and LSS, locally) starts the process, waits for it to listen
// on the address in AWS_LAMBDA_HTTP_ENDPOINT, and proxies the endpoint's
// traffic to it — many requests per process at once.
//
//   GET /                  HTML status page (live SSE feed + recent orders)
//   GET /api/health        JSON: which revision answered, and the request id
//   GET /api/orders        every stored order (DynamoDB Scan)
//   GET /api/orders/:id    one order (DynamoDB GetItem) — 404 when unknown
//   GET /api/stream        Server-Sent Events: three order-status events, then
//                          the stream ends (proves responses are not buffered)
//   GET /api/slow?ms=N     answers after N ms — past TimeoutSeconds it is the
//                          endpoint, not this app, that answers (504)
//
// The DynamoDB client gets no endpoint and no credentials: inside a Lambda the
// SDK takes both from the environment, and LSS points AWS_ENDPOINT_URL at its
// engine with dummy credentials — the code below is the code you deploy.
const http = require('node:http');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.ORDERS_TABLE;
const CHANNEL = process.env.RELEASE_CHANNEL || 'stable';
const TITLE = process.env.APP_TITLE || 'Orders';
const startedAt = new Date();

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function page(requestId) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${TITLE}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; background: #0b1120; color: #e2e8f0; }
  main { max-width: 860px; margin: 0 auto; padding: 32px 24px; }
  h1 { margin: 0 0 4px; font-size: 26px; } .muted { color: #94a3b8; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 24px 0; }
  .card { background: #111a2e; border: 1px solid #1e293b; border-radius: 10px; padding: 14px 16px; }
  .card > b { display: block; font-size: 12px; color: #94a3b8; font-weight: 500; text-transform: uppercase; letter-spacing: .04em; }
  code { font: 13px ui-monospace, monospace; color: #5eead4; }
  .tag { display: inline-block; padding: 1px 8px; border-radius: 999px; background: #134e4a; color: #5eead4; font-size: 12px; }
  ul { padding-left: 18px; } li { margin: 4px 0; }
</style></head>
<body><main>
  <h1>${TITLE} <span class="tag">${CHANNEL}</span></h1>
  <div class="muted">A Lambda Web Function on plain node:http, served locally by LSS.</div>
  <div class="grid">
    <div class="card"><b>Request id</b><code>${requestId || '—'}</code></div>
    <div class="card"><b>Listening on</b><code>${process.env.AWS_LAMBDA_HTTP_ENDPOINT}</code></div>
    <div class="card"><b>Process up since</b><code>${startedAt.toISOString().slice(11, 19)} UTC · pid ${process.pid}</code></div>
  </div>
  <div class="card"><b>Live order feed (Server-Sent Events · /api/stream)</b><ul id="feed"></ul></div>
  <div class="card" style="margin-top:12px"><b>Stored orders (DynamoDB · /api/orders)</b><ul id="orders"><li class="muted">loading…</li></ul></div>
  <p class="muted">Try <code>/api/health</code>, <code>/api/orders/&lt;id&gt;</code>, <code>/api/stream</code>, <code>/api/slow?ms=15000</code>.</p>
</main>
<script>
  const feed = document.getElementById('feed');
  const source = new EventSource('/api/stream');
  source.addEventListener('order-status', e => {
    const d = JSON.parse(e.data);
    const li = document.createElement('li');
    li.innerHTML = '<code>' + d.at.slice(11, 23) + '</code> order <b>' + d.orderId + '</b> → ' + d.status;
    feed.appendChild(li);
  });
  source.addEventListener('done', () => source.close());
  fetch('/api/orders').then(r => r.json()).then(({ orders }) => {
    const list = document.getElementById('orders');
    list.innerHTML = orders.length
      ? orders.slice(0, 8).map(o => '<li><code>' + o.id + '</code> ' + o.customerId + ' · ' + o.total + ' · <span class="tag">' + o.status + '</span></li>').join('')
      : '<li class="muted">No orders yet — POST /orders on the orders-service API.</li>';
  });
</script>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
  const requestId = req.headers['lambda-web-request-id'];
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method !== 'GET') return sendJson(res, 405, { message: 'Method not allowed' });

    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(page(requestId));
    }

    if (url.pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'orders-web',
        channel: CHANNEL,
        requestId,
        // What the app sees behind the endpoint: https, as on AWS.
        forwardedProto: req.headers['x-forwarded-proto'],
        pid: process.pid,
      });
    }

    if (url.pathname === '/api/orders') {
      const result = await doc.send(new ScanCommand({ TableName: TABLE }));
      return sendJson(res, 200, { count: result.Count ?? 0, orders: result.Items ?? [] });
    }

    const match = /^\/api\/orders\/([^/]+)$/.exec(url.pathname);
    if (match) {
      const result = await doc.send(new GetCommand({ TableName: TABLE, Key: { id: decodeURIComponent(match[1]) } }));
      return result.Item ? sendJson(res, 200, result.Item) : sendJson(res, 404, { message: `Order ${match[1]} not found` });
    }

    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const statuses = ['received', 'billed', 'shipped'];
      let sent = 0;
      const timer = setInterval(() => {
        const event = { orderId: 'demo-1', status: statuses[sent], at: new Date().toISOString() };
        res.write(`event: order-status\ndata: ${JSON.stringify(event)}\n\n`);
        sent++;
        if (sent === statuses.length) {
          clearInterval(timer);
          res.end('event: done\ndata: {}\n\n');
        }
      }, 400);
      req.on('close', () => clearInterval(timer));
      return undefined;
    }

    if (url.pathname === '/api/slow') {
      const ms = Math.min(Number(url.searchParams.get('ms')) || 1000, 60000);
      await new Promise(resolve => setTimeout(resolve, ms));
      return sendJson(res, 200, { waitedMs: ms });
    }

    return sendJson(res, 404, { message: `No route for ${url.pathname}` });
  } catch (err) {
    console.error('request failed', err);
    return sendJson(res, 500, { message: err.message });
  }
});

// Lambda chooses the address; the fallback only applies to a bare `node` run.
const [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT || 'localhost:3000').split(':');
server.listen(Number(port), host, () => {
  console.log(`orders-web (${CHANNEL}) listening on ${host}:${port}`);
});

// Lambda sends SIGTERM and allows 1 s before terminating the environment.
process.on('SIGTERM', () => {
  console.log('orders-web: SIGTERM received, closing');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
});
