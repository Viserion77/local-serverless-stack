// A well-behaved web function: listens on AWS_LAMBDA_HTTP_ENDPOINT and serves
// the routes the manager/gateway tests drive. Plain node:http, no dependencies.
const http = require('node:http');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/echo') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.writeHead(201, { 'content-type': 'application/json', 'x-app': 'echo' });
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
    });
    return;
  }
  if (url.pathname === '/env') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(process.env));
    return;
  }
  if (url.pathname === '/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let sent = 0;
    const timer = setInterval(() => {
      sent++;
      res.write(`data: ${sent}\n\n`);
      if (sent === 3) {
        clearInterval(timer);
        res.end();
      }
    }, 150);
    return;
  }
  if (url.pathname === '/sleep') {
    setTimeout(() => res.end('slept'), Number(url.searchParams.get('ms') || 1000));
    return;
  }
  if (url.pathname === '/head-then-hang') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('partial');
    return;
  }
  if (url.pathname === '/head-then-reset') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('partial');
    setTimeout(() => req.socket.destroy(), 50);
    return;
  }
  if (url.pathname === '/crash') {
    process.exit(1);
  }
  if (url.pathname === '/reset') {
    req.socket.destroy();
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`hello from ${process.env.RELEASE || 'app'}`);
});

const [host, port] = process.env.AWS_LAMBDA_HTTP_ENDPOINT.split(':');
server.listen(Number(port), host, () => {
  console.log(`app listening on ${host}:${port}`);
  console.error('a line on stderr');
  for (let i = 0; i < Number(process.env.LOG_LINES || 0); i++) console.log(`line ${i}`);
  process.stdout.write('partial line without newline');
});
process.on('SIGTERM', () => process.exit(0));
