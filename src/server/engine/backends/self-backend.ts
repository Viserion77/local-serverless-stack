// In-process self engine backend: opens the JSONL store, constructs the
// emulators + dispatcher + scheduler over a shared EngineContext, rearms
// event delivery from persisted metadata (ESMs, schedule rules) and binds the
// AWS wire front door on config.port. Boot is file reads only — no Docker, no
// health polling, no sleeps (PRD RF1.2: well under 500 ms).

import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Socket } from 'net';
import type { AddressInfo } from 'net';
import { ConfigManager, type ResolvedSelfEngineConfig } from '../../services/config-manager.js';
import { getBindHost } from '../../services/bind-host.js';
import type { AnyEmulator, DispatcherApi, EngineContext, ResettableEmulator } from '../types.js';
import { AwsError } from '../http/errors.js';
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
import { SsmEmulator } from '../emulators/ssm/index.js';
import { LambdaCtlEmulator } from '../emulators/lambda-ctl/index.js';
import { OpenSearchEmulator } from '../emulators/opensearch/index.js';
import { ApiGatewayEmulator } from '../emulators/apigateway/index.js';
import { EngineDispatcher } from '../dispatch/dispatcher.js';
import { EngineScheduler } from '../dispatch/scheduler.js';

const SERVICES = ['dynamodb', 'sqs', 'sns', 's3', 'events', 'lambda', 'sts', 'secretsmanager', 'ssm', 'aoss', 'apigateway'] as const;
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
  private dynamo: DynamoDbEmulator | null = null;
  private apiGateway: ApiGatewayEmulator | null = null;
  // Every emulator of the current build, for the per-service reset.
  private emulators: AnyEmulator[] = [];
  private dispatcher: EngineDispatcher | null = null;
  private scheduler: EngineScheduler | null = null;
  private server: http.Server | null = null;
  // Keep-alive sockets must be destroyed for server.close() not to hang.
  private readonly sockets = new Set<Socket>();
  private boundPort: number | null = null;
  private running = false;
  // Set while reset() rebuilds the engine; the stable front handler parks new
  // requests on it so none reaches a half-torn-down emulator.
  private resetting: Promise<void> | null = null;
  // What the listener (ours or the orchestrator's) actually calls. Stable for
  // the backend's lifetime: reset() swaps `handler` underneath it, and the
  // orchestrator captured this reference once, at startEmbedded().
  private readonly frontHandler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const dispatch = (): void => (this.handler as (r: http.IncomingMessage, s: http.ServerResponse) => void)(req, res);
    if (this.resetting) void this.resetting.then(dispatch, dispatch);
    else dispatch();
  };

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
    return this.frontHandler;
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
    const ssm = new SsmEmulator(ctx);
    const lambdaCtl = new LambdaCtlEmulator(ctx);
    const opensearch = new OpenSearchEmulator(ctx);
    const apiGateway = new ApiGatewayEmulator(ctx);
    this.sqs = sqs;
    this.apiGateway = apiGateway;
    this.dynamo = dynamo;

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
    // Background TTL deleter: expired items go away (and emit their stream
    // REMOVE) without waiting for a read to notice them.
    dynamo.startTtlSweeper();

    this.emulators = [dynamo, sqs, s3, events, sns, sts, secretsManager, ssm, lambdaCtl, opensearch, apiGateway];
    const handler = createEngineRequestHandler({
      ctx,
      onReset: (service) => (service === undefined ? this.reset() : this.resetService(service)),
      emulators: this.emulators,
    });
    this.handler = handler;

    // Embedded: the orchestrator owns the listener. Rebuilt by reset(): the
    // listener from the first start() is still bound and already routes
    // through frontHandler. Either way everything above is already live.
    if (this.embedded || this.server) {
      this.running = true;
      return;
    }

    const server = http.createServer(this.frontHandler);
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
      // Split-listener mode only: `startEmbedded()` returns above and the
      // orchestrator's own socket carries the wire instead.
      //
      // This asked for '0.0.0.0' outright, which put the *entire* AWS data
      // plane — Scan/PutItem on any table, ReceiveMessage on any queue,
      // GetObject on any bucket, GetSecretValue on any secret, all
      // unauthenticated, since SigV4 here is parsed for the region and never
      // verified — on every interface the moment `serverPort` and
      // `selfEngine.port` were given different values, even while the dashboard
      // sat on loopback. It reads the same bind host as every other listener
      // now, so splitting the ports splits nothing else.
      server.listen(config.port, getBindHost());
    });
    this.boundPort = (server.address() as AddressInfo).port;
    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    this.haltBackgroundWork();

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

  /**
   * Wipe every emulator's state — tables, queues and their messages, buckets
   * and objects, topics, buses and rules, secrets, parameters, collections,
   * Lambda metadata and event source mappings — without restarting the process
   * or rebinding a port. Served as `POST /_lss/reset`.
   *
   * Implemented as teardown + rebuild rather than a per-emulator `clear()`:
   * every emulator, the dispatcher's delivery loops and the scheduler come back
   * exactly as a cold boot over an empty data dir builds them, so a new
   * emulator is covered with no reset code of its own. In persistent mode the
   * data dir's contents are deleted (after a final flush, so no debounced
   * write lands in the fresh tree); in memory mode the old store is simply
   * dropped. Concurrent calls share one reset.
   */
  async reset(): Promise<void> {
    if (!this.running) throw new Error('The self engine is not running');
    this.resetting ??= this.doReset().finally(() => {
      this.resetting = null;
    });
    return this.resetting;
  }

  /**
   * Wipe ONE emulator's state in place (`POST /_lss/reset?service=<name>`),
   * leaving every other service — and the delivery loops — untouched. Only
   * emulators that implement `resetState` support it (today: apigateway); the
   * others share state with the dispatcher (ESM loops, schedules, stream
   * tailers), so they are only ever reset together, by the full rebuild.
   */
  async resetService(service: string): Promise<void> {
    if (!this.running) throw new Error('The self engine is not running');
    // A whole-engine reset in flight swaps every emulator: wait for the new set.
    if (this.resetting) await this.resetting;
    const emulator = this.emulators.find(candidate => candidate.service === service);
    if (!emulator || !('resetState' in emulator)) {
      const supported = this.emulators.filter(candidate => 'resetState' in candidate).map(candidate => candidate.service);
      throw new AwsError(
        'InvalidParameterValue',
        `Per-service reset is not supported for "${service}" (supported: ${supported.join(', ')}). ` +
          'Omit ?service= to reset the whole engine.',
        { status: 400 },
      );
    }
    await (emulator as unknown as ResettableEmulator).resetState();
    console.log(`[self-engine] reset: ${service} is empty`);
  }

  private async doReset(): Promise<void> {
    const config = this.config as ResolvedSelfEngineConfig;
    const store = this.store as EngineStore;
    this.haltBackgroundWork();
    store.stopSweeper();
    // Settle every pending write first: a debounced catalog flush firing after
    // the wipe would resurrect a file in the fresh tree. Deliberately no SQS
    // snapshot — that is the graceful-shutdown path, and the point here is to
    // forget the messages.
    await store.flushAll();
    if (config.persistence) await wipeDataDir(config.dataDir);
    this.running = false;
    await this.start();
    console.log(`[self-engine] reset: every emulator is empty${config.persistence ? ` (${config.dataDir} wiped)` : ''}`);
  }

  // Everything that runs on a timer or a loop, outside request handling.
  private haltBackgroundWork(): void {
    this.scheduler?.stop();
    this.dynamo?.stopTtlSweeper();
    this.dispatcher?.stop();
  }

  isRunning(): boolean {
    return this.running;
  }

  getEndpoint(): string {
    return `http://localhost:${this.boundPort ?? this.resolveConfig().port}`;
  }

  /**
   * The AWS wire handler — non-null once start()/startEmbedded() resolved.
   * Always the stable front handler, so a caller that keeps it keeps working
   * across reset().
   */
  getRequestHandler(): ((req: http.IncomingMessage, res: http.ServerResponse) => void) | null {
    return this.handler ? this.frontHandler : null;
  }

  /**
   * The API Gateway control-plane emulator (API keys, usage plans), for the
   * in-process gateway that enforces `private: true` routes. Re-read on every
   * use: reset() rebuilds the emulators, so a captured instance goes stale.
   */
  getApiGateway(): ApiGatewayEmulator {
    if (!this.apiGateway) throw new Error('The self engine is not running');
    return this.apiGateway;
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

// Delete the CONTENTS of the engine data dir (the dir itself stays, so a
// symlinked or bind-mounted one survives). `selfEngine.dataDir` is
// user-configurable, so before deleting anything this checks the directory is
// not something far bigger than engine state: a filesystem root, the home
// directory, the working directory, or a directory holding a project's own
// files. The engine's tree never contains any of those markers.
const PROJECT_MARKERS = ['package.json', '.git', 'lss.config.json', '.lssrc', 'serverless.yml'];

export async function wipeDataDir(dataDir: string): Promise<void> {
  const dir = path.resolve(dataDir);
  if (dir === path.parse(dir).root || dir === path.resolve(os.homedir()) || dir === process.cwd()) {
    throw new Error(`Refusing to wipe ${dir}: selfEngine.dataDir must be a dedicated engine directory`);
  }
  const entries = await fs.promises.readdir(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return [] as string[];
    throw err;
  });
  const marker = entries.find(entry => PROJECT_MARKERS.includes(entry));
  if (marker) {
    throw new Error(
      `Refusing to wipe ${dir}: it contains ${marker}, so it is not a dedicated engine data directory`,
    );
  }
  await Promise.all(entries.map(entry => fs.promises.rm(path.join(dir, entry), { recursive: true, force: true })));
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
