// End-to-end against the REAL SelfEngineBackend: a template whose names are
// written with intrinsics (Fn::Sub over AWS::StackName, Fn::Join over a
// parameter, Fn::FindInMap, a Condition) is parsed, provisioned and its
// function environment resolved exactly as the registrar does it — and every
// value a handler would read from process.env is then used against the engine
// through the AWS SDK. Before the static pass these names reached the
// provisioner as objects and the env carried logical ids ("OrdersTable"), so a
// handler talked to resources that did not exist.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { SQSClient, SendMessageCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';

// lambda-runtime-manager uses import.meta.url (ESM-only), which jest's CJS
// transform cannot load; nothing here invokes a function.
jest.mock('../../../src/server/services/lambda-runtime-manager', () => ({
  LambdaRuntimeManager: { getInstance: () => ({ invoke: jest.fn() }) },
}));

import { SelfEngineBackend } from '../../../src/server/engine/backends/self-backend.js';
import { EngineManager } from '../../../src/server/engine/engine-manager.js';
import { ResourceProvisioner } from '../../../src/server/services/resource-provisioner.js';
import { CloudFormationParser, type LambdaResource } from '../../../src/server/services/cloudformation-parser.js';
import { EnvironmentResolver } from '../../../src/server/services/cfn-physical-values.js';
import type { ResolvedSelfEngineConfig } from '../../../src/server/services/config-manager.js';

const REGION = 'us-east-1';
const CREDS = { accessKeyId: 'test', secretAccessKey: 'test' };
const FIXTURE = path.resolve(__dirname, '../../fixtures/intrinsics-template.json');

describe('wire: intrinsic names and physical env values (real self engine)', () => {
  let dataDir: string;
  let backend: SelfEngineBackend;
  let endpoint: string;

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-wire-intrinsics-'));
    backend = new SelfEngineBackend({
      port: 0, dataDir, account: '000000000000', region: REGION,
      idleUnloadMs: 300_000, memoryBudgetMb: 64, fsync: false, fallbackEndpoint: null, persistence: false,
    } as Partial<ResolvedSelfEngineConfig>);
    await backend.start();
    endpoint = backend.getEndpoint();
    jest.spyOn(EngineManager.getInstance(), 'getConfig').mockReturnValue({ endpoint, region: REGION, credentials: CREDS });
    (ResourceProvisioner.getInstance() as any).initializeClients(REGION);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await backend.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('provisions the resolved names and hands the function values that work', async () => {
    const template = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const warnings: string[] = [];
    const context = { region: REGION, stackName: 'acme-orders-dev' };
    const { resources } = new CloudFormationParser().parseTemplate(template, warnings, context);

    const provisioner = ResourceProvisioner.getInstance();
    const outcome = await provisioner.provisionResources('acme-orders', resources, { region: REGION });
    expect(outcome.warnings).toEqual([]);

    const env = new EnvironmentResolver({
      template,
      ...context,
      resources,
      runtime: await provisioner.lookupRuntimeAttributes(resources),
      warnings,
    }).resolve((resources.find(r => r.type === 'lambda') as LambdaResource).environment);

    const ddb = new DynamoDBClient({ endpoint, region: REGION, credentials: CREDS });
    const sqs = new SQSClient({ endpoint, region: REGION, credentials: CREDS });
    const s3 = new S3Client({ endpoint, region: REGION, credentials: CREDS, forcePathStyle: true });
    try {
      expect(env.TABLE_NAME).toBe('acme-orders-dev-orders');
      const table = await ddb.send(new DescribeTableCommand({ TableName: env.TABLE_NAME }));
      // The stream label is minted at CreateTable — the env has the real one.
      expect(env.STREAM_ARN).toBe(table.Table?.LatestStreamArn);

      // Ref on a queue is its URL, and that URL is one the SDK can use.
      await sqs.send(new SendMessageCommand({ QueueUrl: env.QUEUE_URL, MessageBody: 'hello' }));
      const attrs = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: env.QUEUE_URL, AttributeNames: ['QueueArn', 'VisibilityTimeout'] }));
      expect(env.QUEUE_ARN).toBe(attrs.Attributes?.QueueArn);
      // Fn::FindInMap reached the queue's attributes too.
      expect(attrs.Attributes?.VisibilityTimeout).toBe('30');

      expect(env.BUCKET).toBe('acme-uploads-sandbox-us');
      await s3.send(new HeadBucketCommand({ Bucket: env.BUCKET }));

      expect(env).toMatchObject({ STAGE: 'dev', AUDIT: 'disabled', DEBUG: 'true', RETENTION: '4' });
      // Nothing fell back to a logical id.
      expect(warnings.filter(w => w.startsWith('Environment variable'))).toEqual([]);
    } finally {
      ddb.destroy();
      sqs.destroy();
      s3.destroy();
    }
  });
});
