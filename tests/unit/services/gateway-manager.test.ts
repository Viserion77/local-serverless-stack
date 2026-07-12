// Unit tests for GatewayManager's bind lifecycle, focused on EADDRINUSE
// recovery: a port conflict must flag 'port-conflict' (never fail), keep
// retrying on a short interval, flip to 'online' once the port frees up, and
// stop retrying the moment the service stops. Real localhost listeners on
// ephemeral ports keep this hermetic; the request-handling paths (coverage-
// excluded, integration-tested) are not driven here. The runtime manager is
// jest.mocked — the real module forks workers and uses import.meta.
import http from 'http';
import type { AddressInfo } from 'net';

jest.mock('../../../src/server/services/lambda-runtime-manager', () => {
  const instance = { invoke: jest.fn() };
  return { LambdaRuntimeManager: { getInstance: () => instance } };
});

import { GatewayManager } from '../../../src/server/services/gateway-manager';
import type { ServiceEntry } from '../../../src/server/services/function-registry';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function entryFor(name: string, apiPort?: number, invokePort?: number): ServiceEntry {
  return {
    name,
    root: `/proj/${name}`,
    stage: 'dev',
    apiPort,
    invokePort,
    functions: invokePort
      ? [{ name: 'fn', fullName: `${name}-dev-fn`, handler: 'h.handler', runtime: 'nodejs20.x', memorySize: 128, timeout: 6, environment: {}, triggers: [] }]
      : [],
    routes: apiPort
      ? [{ functionName: 'fn', method: 'GET', path: '/ping', eventType: 'httpApi' as const, cors: false }]
      : [],
    authorizers: [],
  };
}

// Occupy an ephemeral port so the gateway's bind hits EADDRINUSE.
function occupy(): Promise<http.Server> {
  return new Promise(resolve => {
    const blocker = http.createServer((_req, res) => { res.statusCode = 503; res.end(); });
    blocker.listen(0, () => resolve(blocker));
  });
}

const portOf = (s: http.Server) => (s.address() as AddressInfo).port;
const closeServer = (s: http.Server) => new Promise<void>(r => s.close(() => r()));

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await sleep(10);
  }
}

// True when nothing is listening on the port (we can bind and release it).
function portIsFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const probe = http.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, () => probe.close(() => resolve(true)));
  });
}

let gm: GatewayManager;
let warnSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;

beforeEach(() => {
  gm = new GatewayManager();
  gm.rebindIntervalMs = 25;
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  await gm.stopAll();
  jest.restoreAllMocks();
});

it('binds immediately when the port is free and releases it on removeService', async () => {
  // Grab an ephemeral port number, then free it for the gateway.
  const placeholder = await occupy();
  const port = portOf(placeholder);
  await closeServer(placeholder);

  await gm.syncService(entryFor('svc-free', port), true);
  expect(gm.getInfo('svc-free').api.status).toBe('online');
  expect(await portIsFree(port)).toBe(false);

  await gm.removeService('svc-free');
  expect(await portIsFree(port)).toBe(true);
});

it('reports port-conflict on EADDRINUSE for both listeners and recovers once the ports free up', async () => {
  const apiBlocker = await occupy();
  const invokeBlocker = await occupy();
  const apiPort = portOf(apiBlocker);
  const invokePort = portOf(invokeBlocker);

  await gm.syncService(entryFor('svc-conflict', apiPort, invokePort), true);
  expect(gm.getInfo('svc-conflict')).toEqual({
    api: { port: apiPort, status: 'port-conflict' },
    invoke: { port: invokePort, status: 'port-conflict' },
  });
  expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`port ${apiPort} already in use — retrying every 25ms`));
  expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`port ${invokePort} already in use — retrying every 25ms`));

  // Stay conflicted for several retry windows — retries must keep going, not
  // give up after the first attempt.
  await sleep(100);
  expect(gm.getInfo('svc-conflict').api.status).toBe('port-conflict');
  expect(gm.getInfo('svc-conflict').invoke.status).toBe('port-conflict');

  await closeServer(apiBlocker);
  await closeServer(invokeBlocker);
  await waitFor(() =>
    gm.getInfo('svc-conflict').api.status === 'online'
    && gm.getInfo('svc-conflict').invoke.status === 'online');

  expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(`recovered from port conflict — listening on http://localhost:${apiPort}`));
  // The gateway now actually owns the ports.
  expect(await portIsFree(apiPort)).toBe(false);
  expect(await portIsFree(invokePort)).toBe(false);
});

it('stopService cancels pending rebind attempts — a stopped service never grabs the port later', async () => {
  const blocker = await occupy();
  const port = portOf(blocker);

  await gm.syncService(entryFor('svc-stopped', port), true);
  expect(gm.getInfo('svc-stopped').api.status).toBe('port-conflict');

  await gm.stopService('svc-stopped');
  await closeServer(blocker);

  // Give would-be retries several intervals to (wrongly) fire.
  await sleep(150);
  expect(await portIsFree(port)).toBe(true);
  expect(gm.getInfo('svc-stopped').api.status).not.toBe('online');
});

it('re-syncing a conflicted service replaces its retry timers with the new bind', async () => {
  const blocker = await occupy();
  const port = portOf(blocker);

  const entry = entryFor('svc-resync', port);
  await gm.syncService(entry, true);
  expect(gm.getInfo('svc-resync').api.status).toBe('port-conflict');

  // Re-register while still conflicted (e.g. a hot reload): the old timers are
  // cancelled with the old server, and the fresh bind conflicts again...
  await gm.syncService(entry, true);
  expect(gm.getInfo('svc-resync').api.status).toBe('port-conflict');

  // ...until the port frees up and the NEW listener takes over.
  await closeServer(blocker);
  await waitFor(() => gm.getInfo('svc-resync').api.status === 'online');
  expect(await portIsFree(port)).toBe(false);
});
