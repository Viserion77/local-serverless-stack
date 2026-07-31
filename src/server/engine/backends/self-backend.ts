// In-process self engine backend: opens the JSONL store, constructs the
// emulators + dispatcher + scheduler over a shared EngineContext, rearms
// event delivery from persisted metadata (ESMs, schedule rules) and binds the
// AWS wire front door on config.port. Boot is file reads only — no Docker, no
// health polling, no sleeps (PRD RF1.2: well under 500 ms).

import http from 'http';
import fs from 'fs';
import path from 'path';
import type { Socket } from 'net';
import type { AddressInfo } from 'net';
import { ConfigManager, type ResolvedSelfEngineConfig } from '../../services/config-manager.js';
import type { DispatcherApi, EngineContext } from '../types.js';
import { EngineBus } from '../bus.js';
import { createEngineStore } from '../store/engine-store.js';
import type { EngineStore } from '../store/store-types.js';
import { createEngineRequestHandler } from '../http/router.js';
import { DynamoDbEmulator } from '../emulators/dynamodb/index.js';
import { SqsEmulator, type SqsMessagesSnapshot } from '../emulators/sqs/index.js';
import { S3Emulator } from '../emulators/s3/index.js';
import { EventsEmulator } from '../emulators/events/index.js';
import { SnsEmulator } from '../emulators/sns/index.js';
import { StsEmulator } from '../emulators/sts.js';
import { SecretsManagerEmulator } from '../emulators/secretsmanager/index.js';
import { LambdaCtlEmulator } from '../emulators/lambda-ctl/index.js';
import { OpenSearchEmulator } from '../emulators/opensearch/index.js';
import { EngineDispatcher } from '../dispatch/dispatcher.js';
import { EngineScheduler } from '../dispatch/scheduler.js';

const SERVICES = ['dynamodb', 'sqs', 'sns', 's3', 'events', 'lambda', 'sts', 'secretsmanager', 'aoss'] as const;
const SQS_SNAPSHOT_FILE = 'sqs-messages.snapshot.json';

export class SelfEngineBackend {
  readonly kind = 'self' as const;

  private readonly overrides: Partial<ResolvedSelfEngineConfig>;
  // Set when the engine shares the orchestrator's listener instead of binding
  // its own: start() builds everything but skips listen(), and the caller
  // mounts getRequestHandler() behind its own server.
  private embedded = false;
  private handler: ((req: http.IncomingMessage, res: http.ServerResponse) => void) | null = null;
  private config: ResolvedSelfEngineConfig | null = null;
  private store: EngineStore | null = null;
  private sqs: SqsEmulator | null = null;
  private dispatcher: EngineDispatcher | null = null;
  private scheduler: EngineScheduler | null = null;
  private server: http.Server | null = null;
  // Keep-alive sockets must be destroyed for server.close() not to hang.
  private readonly sockets = new Set<Socket>();
  private boundPort: number | null = null;
  private running = false;

  // `overrides` merge over ConfigManager's resolved self-engine config —
  // tests use it for ephemeral ports (0) and temp data dirs.
  constructor(overrides: Partial<ResolvedSelfEngineConfig> = {}) {
    this.overrides = overrides;
  }

  /**
   * Build the engine without binding a port. The returned handler answers the
   * AWS wire; the caller decides which requests reach it (see is-aws-request).
   */
  async startEmbedded(): Promise<(req: http.IncomingMessage, res: http.ServerResponse) => void> {
    this.embedded = true;
    await this.start();
    // start() always assigns the handler before returning.
    return this.handler as (req: http.IncomingMessage, res: http.ServerResponse) => void;
  }

  async start(): Promise<void> {
    if (this.running) return;
    const config = this.resolveConfig();
    this.config = config;

    const store = createEngineStore({
      dataDir: config.dataDir,
      idleUnloadMs: config.idleUnloadMs,
      memoryBudgetMb: config.memoryBudgetMb,
      fsync: config.fsync,
      // `persistence: false` must mean it: no dataDir, no catalogs, no WAL —
      // otherwise tables and queues survive a restart and the run leaves a
      // `.lss/engine/` tree behind.
      persistence: config.persistence,
    });
    this.store = store;
    const bus = new EngineBus();
    const ctx: EngineContext = {
      config,
      store,
      bus,
      // Late-bound below; emulators only touch it while handling requests.
      dispatcher: notReadyDispatcher(),
      endpoint: () => this.getEndpoint(),
    };

    const dynamo = new DynamoDbEmulator(ctx);
    const sqs = new SqsEmulator(ctx);
    const s3 = new S3Emulator(ctx);
    const events = new EventsEmulator(ctx);
    const sns = new SnsEmulator(ctx);
    const sts = new StsEmulator(ctx);
    const secretsManager = new SecretsManagerEmulator(ctx);
    const lambdaCtl = new LambdaCtlEmulator(ctx);
    const opensearch = new OpenSearchEmulator(ctx);
    this.sqs = sqs;

    const dispatcher = new EngineDispatcher({ ctx, sqs, dynamo, s3, events, lambdaCtl });
    ctx.dispatcher = dispatcher;
    this.dispatcher = dispatcher;
    const scheduler = new EngineScheduler({
      ctx,
      events,
      deliverToTarget: dispatcher.deliverToTarget.bind(dispatcher),
    });
    this.scheduler = scheduler;

    // Restore the graceful-shutdown SQS message snapshot before the delivery
    // loops start draining.
    if (config.persistence) this.restoreSqsSnapshot(config, sqs);

    // Rearm delivery from persisted metadata: ESM loops + schedule rules
    // survive engine restarts (PRD RF8.2).
    await dispatcher.start(config.region);
    await scheduler.resync(config.region);
    store.startSweeper();

    const handler = createEngineRequestHandler({
      ctx,
      emulators: [dynamo, sqs, s3, events, sns, sts, secretsManager, lambdaCtl, opensearch],
    });
    this.handler = handler;

    if (this.embedded) {
      // The orchestrator owns the listener; everything above is already live.
      this.running = true;
      return;
    }

    const server = http.createServer(handler);
    server.on('connection', socket => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE') {
          reject(new Error(
            `Self engine could not bind port ${config.port}: address already in use. ` +
              'Another process is listening there — a real LocalStack install intercepts ports ' +
              '4566-4599 on some hosts. Stop the conflicting process or set selfEngine.port to a free port.',
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
      server.listen(config.port, '0.0.0.0');
    });
    this.boundPort = (server.address() as AddressInfo).port;
    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    this.scheduler?.stop();
    this.dispatcher?.stop();

    const config = this.config as ResolvedSelfEngineConfig;
    if (config.persistence && this.sqs && this.store) {
      try {
        const snapshot = JSON.stringify(this.sqs.serializeMessages());
        await fs.promises.writeFile(path.join(this.store.dir(), SQS_SNAPSHOT_FILE), snapshot);
      } catch (err) {
        console.warn('[self-engine] failed to snapshot SQS messages:', err);
      }
    }

    if (this.store) {
      await this.store.flushAll();
      this.store.stopSweeper();
    }

    const server = this.server;
    if (server) {
      await new Promise<void>(resolve => {
        server.close(() => resolve());
        for (const socket of this.sockets) socket.destroy();
        this.sockets.clear();
      });
      this.server = null;
    }
    this.boundPort = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  getEndpoint(): string {
    return `http://localhost:${this.boundPort ?? this.resolveConfig().port}`;
  }

  /** The AWS wire handler — non-null once start()/startEmbedded() resolved. */
  getRequestHandler(): ((req: http.IncomingMessage, res: http.ServerResponse) => void) | null {
    return this.handler;
  }

  getConfig(): { endpoint: string; region: string; credentials: { accessKeyId: string; secretAccessKey: string } } {
    return {
      endpoint: this.getEndpoint(),
      region: this.resolveConfig().region,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    };
  }

  healthDetail(): Record<string, unknown> {
    const detail: Record<string, unknown> = {
      port: this.boundPort ?? this.resolveConfig().port,
      services: [...SERVICES],
    };
    if (this.running && this.dispatcher && this.scheduler) {
      detail.eventSourceLoops = this.dispatcher.loopCounts();
      detail.scheduleRules = this.scheduler.scheduleCount();
    }
    return detail;
  }

  private resolveConfig(): ResolvedSelfEngineConfig {
    if (this.config) return this.config;
    return { ...ConfigManager.getInstance().getSelfEngineConfig(), ...this.overrides };
  }

  private restoreSqsSnapshot(config: ResolvedSelfEngineConfig, sqs: SqsEmulator): void {
    const file = path.join(config.dataDir, SQS_SNAPSHOT_FILE);
    if (!fs.existsSync(file)) return;
    try {
      const snapshot = JSON.parse(fs.readFileSync(file, 'utf8')) as SqsMessagesSnapshot;
      sqs.restoreMessages(snapshot);
    } catch (err) {
      console.warn(`[self-engine] ignoring unreadable SQS snapshot ${file}:`, err);
    }
  }
}

function notReadyDispatcher(): DispatcherApi {
  return {
    invokeFunction: async () => ({
      ok: false,
      errorType: 'EngineNotReady',
      errorMessage: 'The self engine dispatcher is not wired yet',
    }),
  };
}
