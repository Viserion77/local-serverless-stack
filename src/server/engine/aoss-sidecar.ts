// OpenSearch Serverless (aoss) sidecar: the self-engine OpenSearch emulator
// served in-process behind the engine router, on its own port next to a
// LocalStack engine. No LocalStack edition provides aoss, so LSS fills the
// gap itself — the control plane (X-Amz-Target OpenSearchServerless.*) and
// the data plane (/_aoss/<collection>/...) both answer on this listener,
// persisted under the sidecar's own data dir. Never started in self-engine
// mode, where aoss is native.

import http from 'http';
import type { Socket } from 'net';
import type { AddressInfo } from 'net';
import type { EngineContext } from './types.js';
import { EngineBus } from './bus.js';
import { createEngineStore } from './store/engine-store.js';
import { createEngineRequestHandler } from './http/router.js';
import { OpenSearchEmulator } from './emulators/opensearch/index.js';

// Same residency defaults as the self engine (config-manager.ts) — the
// sidecar hosts one emulator, so there is no reason to expose knobs for them.
const IDLE_UNLOAD_MS = 300_000;
const MEMORY_BUDGET_MB = 128;

export interface AossSidecarOptions {
  // 0 binds an ephemeral port (tests); the endpoint always reflects the
  // actually bound port.
  port: number;
  dataDir: string;
  region: string;
  account?: string;
}

export interface AossSidecarHandle {
  port: number;
  endpoint: string;
  close(): Promise<void>;
}

export async function startAossSidecar(opts: AossSidecarOptions): Promise<AossSidecarHandle> {
  const store = createEngineStore({
    dataDir: opts.dataDir,
    idleUnloadMs: IDLE_UNLOAD_MS,
    memoryBudgetMb: MEMORY_BUDGET_MB,
    fsync: false,
  });

  // The emulator resolves collectionEndpoint through ctx.endpoint() at request
  // time; a closure over the mutable port keeps it correct once listen() has
  // picked the real port (port 0 case).
  let boundPort = opts.port;
  const ctx: EngineContext = {
    config: {
      port: opts.port,
      dataDir: opts.dataDir,
      account: opts.account ?? '000000000000',
      region: opts.region,
      idleUnloadMs: IDLE_UNLOAD_MS,
      memoryBudgetMb: MEMORY_BUDGET_MB,
      fsync: false,
      fallbackEndpoint: null,
      persistence: true,
    },
    store,
    bus: new EngineBus(),
    // The OpenSearch emulator never invokes functions; the stub keeps the
    // context honest without dragging the dispatcher (and the Lambda runtime)
    // into the sidecar.
    dispatcher: { invokeFunction: async () => ({ ok: true }) },
    endpoint: () => `http://localhost:${boundPort}`,
  };

  const emulator = new OpenSearchEmulator(ctx);
  const handler = createEngineRequestHandler({ ctx, emulators: [emulator] });
  const server = http.createServer(handler);
  // Keep-alive sockets must be destroyed for server.close() not to hang.
  const sockets = new Set<Socket>();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening);
      if (err.code === 'EADDRINUSE') {
        reject(new Error(
          `aoss sidecar could not bind port ${opts.port}: address already in use. ` +
            'Stop the conflicting process or set aossSidecar.port to a free port.',
        ));
      } else {
        reject(err);
      }
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(opts.port, '0.0.0.0');
  });
  boundPort = (server.address() as AddressInfo).port;
  store.startSweeper();

  return {
    port: boundPort,
    endpoint: `http://localhost:${boundPort}`,
    async close(): Promise<void> {
      await store.flushAll();
      store.stopSweeper();
      await new Promise<void>(resolve => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
        sockets.clear();
      });
    },
  };
}
