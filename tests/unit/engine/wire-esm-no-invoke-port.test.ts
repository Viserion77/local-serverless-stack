// End-to-end against the REAL SelfEngineBackend: a service registered WITHOUT
// an invoke port (the normal self-engine case — nothing listens on 130xx) must
// still get its SQS event source mapping and its EventBridge rule target wired,
// and events must reach the function through the in-process registry path of
// the dispatcher. The provisioner used to refuse ("no invoke URL configured"),
// which left every queue and rule of such a service silently unwired.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { SQSClient, SendMessageCommand, GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { LambdaClient, ListEventSourceMappingsCommand } from '@aws-sdk/client-lambda';

// lambda-runtime-manager uses import.meta.url (ESM-only), which jest's CJS
// transform cannot load — and the point here is what the dispatcher hands it.
const invoke = jest.fn();
jest.mock('../../../src/server/services/lambda-runtime-manager', () => ({
  LambdaRuntimeManager: { getInstance: () => ({ invoke }) },
}));

import { SelfEngineBackend } from '../../../src/server/engine/backends/self-backend.js';
import { EngineManager } from '../../../src/server/engine/engine-manager.js';
import { ResourceProvisioner } from '../../../src/server/services/resource-provisioner.js';
import { FunctionRegistry } from '../../../src/server/services/function-registry.js';
import type { Resource } from '../../../src/server/services/cloudformation-parser.js';
import type { ResolvedSelfEngineConfig } from '../../../src/server/services/config-manager.js';

const REGION = 'us-east-1';
const CREDS = { accessKeyId: 'test', secretAccessKey: 'test' };

function makeConfig(dataDir: string): Partial<ResolvedSelfEngineConfig> {
  return {
    port: 0, dataDir, account: '000000000000', region: REGION,
    idleUnloadMs: 300_000, memoryBudgetMb: 64, fsync: false, fallbackEndpoint: null, persistence: false,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

const lambdaResource = (logicalId: string, name: string): Resource => ({
  type: 'lambda', logicalId, name, handler: 'src/handler.main', runtime: 'nodejs20.x',
  environment: {}, memorySize: 128, timeout: 6,
});

describe('wire: ESM + rule targets without an invoke port (real self engine)', () => {
  let dataDir: string;
  let backend: SelfEngineBackend;
  let endpoint: string;

  beforeEach(async () => {
    invoke.mockReset();
    invoke.mockResolvedValue({ ok: true, payload: null, logs: [], durationMs: 1 });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-wire-noport-'));
    backend = new SelfEngineBackend(makeConfig(dataDir));
    await backend.start();
    endpoint = backend.getEndpoint();
    jest.spyOn(EngineManager.getInstance(), 'getConfig').mockReturnValue({ endpoint, region: REGION, credentials: CREDS });
    (ResourceProvisioner.getInstance() as any).initializeClients(REGION);

    FunctionRegistry.getInstance().registerService({
      name: 'orders',
      root: dataDir,
      region: REGION,
      functions: [
        { name: 'processOrder', fullName: 'orders-dev-processOrder', handler: 'src/handler.main', runtime: 'nodejs20.x', memorySize: 128, timeout: 6, environment: {}, triggers: ['sqs'] },
        { name: 'onShipped', fullName: 'orders-dev-onShipped', handler: 'src/handler.main', runtime: 'nodejs20.x', memorySize: 128, timeout: 6, environment: {}, triggers: ['eventBridge'] },
      ],
      routes: [],
      authorizers: [],
    } as any);
  });

  afterEach(async () => {
    FunctionRegistry.getInstance().removeService('orders');
    jest.restoreAllMocks();
    await backend.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('wires the queue and the rule target and delivers both in-process', async () => {
    const resources: Resource[] = [
      lambdaResource('ProcessOrderLambdaFunction', 'orders-dev-processOrder'),
      lambdaResource('OnShippedLambdaFunction', 'orders-dev-onShipped'),
      { type: 'sqs', logicalId: 'OrdersQueue', name: 'orders-queue' } as Resource,
      {
        type: 'event-source',
        functionName: 'ProcessOrderLambdaFunction',
        eventSourceArn: 'OrdersQueue::Arn',
        batchSize: 1,
        enabled: true,
      } as Resource,
      {
        type: 'event-rule',
        logicalId: 'ShippedRule',
        name: 'orders-shipped',
        enabled: true,
        eventPattern: { source: ['acme.shipping'] },
        targets: [{ id: 'onShipped', functionRef: 'OnShippedLambdaFunction' }],
      } as Resource,
    ];

    // No invokePort / invokeUrl: exactly what a self-engine registration sends.
    const outcome = await ResourceProvisioner.getInstance().provisionResources('orders', resources, { region: REGION });
    expect(outcome.warnings).toEqual([]);

    const lambda = new LambdaClient({ endpoint, region: REGION, credentials: CREDS });
    const mappings = await lambda.send(new ListEventSourceMappingsCommand({ FunctionName: 'orders-dev-processOrder' }));
    expect(mappings.EventSourceMappings).toHaveLength(1);

    const sqs = new SQSClient({ endpoint, region: REGION, credentials: CREDS });
    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: 'orders-queue' }));
    await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: '{"orderId":"o-1"}' }));

    const events = new EventBridgeClient({ endpoint, region: REGION, credentials: CREDS });
    await events.send(new PutEventsCommand({
      Entries: [{ Source: 'acme.shipping', DetailType: 'OrderShipped', Detail: '{"orderId":"o-1"}' }],
    }));

    await waitFor(() => invoke.mock.calls.length >= 2, 10_000, 'both in-process deliveries');
    const byFunction = new Map(invoke.mock.calls.map(([service, fn, event]) => [fn.name, { service, event }]));
    expect(byFunction.get('processOrder')?.service).toBe('orders');
    expect((byFunction.get('processOrder')?.event as any).Records[0].body).toBe('{"orderId":"o-1"}');
    expect((byFunction.get('onShipped')?.event as any)['detail-type']).toBe('OrderShipped');
  }, 20_000);
});
