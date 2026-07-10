import http from 'http';
import type { AddressInfo } from 'net';
import { createEngineRequestHandler, type EngineRouterDeps } from '../../../../src/server/engine/http/router.js';
import { AwsError, dynamoError, s3Error, sqsError } from '../../../../src/server/engine/http/errors.js';
import { EngineBus } from '../../../../src/server/engine/bus.js';
import type {
  AwsRequest,
  AwsResponse,
  EngineContext,
  QueryEmulator,
  RestEmulator,
  SelfEngineResolvedConfig,
  TargetEmulator,
} from '../../../../src/server/engine/types.js';
import type { EngineStore } from '../../../../src/server/engine/store/store-types.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<SelfEngineResolvedConfig> = {}): EngineContext {
  const config: SelfEngineResolvedConfig = {
    port: 0,
    dataDir: '/tmp/unused',
    account: '000000000000',
    region: 'us-east-1',
    idleUnloadMs: 300000,
    memoryBudgetMb: 128,
    fsync: false,
    fallbackEndpoint: null,
    persistence: false,
    ...overrides,
  };
  return {
    config,
    store: {} as EngineStore,
    bus: new EngineBus(),
    dispatcher: { invokeFunction: async () => ({ ok: true }) },
    endpoint: () => `http://127.0.0.1:${config.port}`,
  };
}

interface TargetCall {
  operation: string;
  input: Record<string, unknown>;
  req: AwsRequest;
}

function makeTargetFake(
  service: 'dynamodb' | 'sqs' | 'events',
  targetPrefix: string,
  jsonVersion: '1.0' | '1.1',
): TargetEmulator & { calls: TargetCall[] } {
  const calls: TargetCall[] = [];
  return {
    service,
    targetPrefix,
    jsonVersion,
    calls,
    async handle(operation, input, req) {
      calls.push({ operation, input, req });
      switch (operation) {
        case 'FailAws':
          throw dynamoError('ResourceNotFoundException', 'Requested resource not found');
        case 'FailQueue':
          throw sqsError('QueueNameExists', 'A queue already exists with the same name');
        case 'FailExtra':
          throw new AwsError('TransactionCanceledException', 'Transaction cancelled', {
            extra: { CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] },
          });
        case 'Crash':
          throw new Error('kaput');
        case 'UnknownOp':
          throw new AwsError('UnknownOperationException', 'no such operation');
        default:
          return { ok: true, service, operation };
      }
    },
  };
}

interface QueryCall {
  action: string;
  params: Record<string, string>;
  req: AwsRequest;
}

function makeQueryFake(service: 'sns' | 'sts'): QueryEmulator & { calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  return {
    service,
    calls,
    async handle(action, params, req) {
      calls.push({ action, params, req });
      if (action === 'Fail') throw new AwsError('NotFound', 'Topic does not exist', { status: 404 });
      return `<${action}Response xmlns="https://example.test/doc/">${service}</${action}Response>`;
    },
  };
}

function makeRestFake(service: 's3' | 'lambda'): RestEmulator & { requests: AwsRequest[] } {
  const requests: AwsRequest[] = [];
  return {
    service,
    requests,
    async handle(req) {
      requests.push(req);
      if (req.rawPath.includes('missing')) throw s3Error('NoSuchKey', 'The specified key does not exist.', 404);
      if (req.rawPath.includes('conflict')) {
        throw new AwsError('ResourceConflictException', 'Function already exists', { status: 409 });
      }
      if (req.method === 'DELETE') return { status: 204 };
      const response: AwsResponse = {
        status: 200,
        headers: { 'content-type': service === 's3' ? 'application/xml' : 'application/json' },
        body: service === 's3' ? '<Ok/>' : '{"ok":true}',
      };
      return response;
    },
  };
}

interface Engine {
  port: number;
  ctx: EngineContext;
  dynamo: ReturnType<typeof makeTargetFake>;
  sqs: ReturnType<typeof makeTargetFake>;
  events: ReturnType<typeof makeTargetFake>;
  sns: ReturnType<typeof makeQueryFake>;
  sts: ReturnType<typeof makeQueryFake>;
  s3: ReturnType<typeof makeRestFake>;
  lambda: ReturnType<typeof makeRestFake>;
  close(): Promise<void>;
}

async function startEngine(configOverrides: Partial<SelfEngineResolvedConfig> = {}): Promise<Engine> {
  const ctx = makeCtx(configOverrides);
  const dynamo = makeTargetFake('dynamodb', 'DynamoDB_20120810', '1.0');
  const sqs = makeTargetFake('sqs', 'AmazonSQS', '1.0');
  const events = makeTargetFake('events', 'AWSEvents', '1.1');
  const sns = makeQueryFake('sns');
  const sts = makeQueryFake('sts');
  const s3 = makeRestFake('s3');
  const lambda = makeRestFake('lambda');
  const deps: EngineRouterDeps = { ctx, emulators: [dynamo, sqs, events, sns, sts, s3, lambda] };
  const server = http.createServer(createEngineRequestHandler(deps));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    ctx,
    dynamo,
    sqs,
    events,
    sns,
    sts,
    s3,
    lambda,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

interface TestResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  text: string;
  json: Record<string, unknown>;
}

function request(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer },
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'POST',
        path: options.path ?? '/',
        headers: options.headers ?? {},
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk as Buffer));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          const text = body.toString('utf8');
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            // non-JSON body — callers assert on text instead
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text, json });
        });
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

function auth(service: string, region = 'us-east-1'): string {
  return (
    `AWS4-HMAC-SHA256 Credential=test/20260710/${region}/${service}/aws4_request, ` +
    'SignedHeaders=content-type;host, Signature=deadbeef'
  );
}

let engine: Engine;
beforeEach(async () => {
  engine = await startEngine();
});
afterEach(async () => {
  await engine.close();
});

// ---------------------------------------------------------------------------
// Health endpoints
// ---------------------------------------------------------------------------

describe('health endpoints', () => {
  it('serves GET /_lss/health', async () => {
    const res = await request(engine.port, { method: 'GET', path: '/_lss/health' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: 'ok', engine: 'self' });
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.headers['date']).toBeDefined();
    expect(res.headers['x-amzn-requestid']).toBeDefined();
    expect(res.headers['content-length']).toBe(String(res.body.length));
  });

  it('serves the LocalStack-shaped GET /_localstack/health', async () => {
    const res = await request(engine.port, { method: 'GET', path: '/_localstack/health' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      services: {
        dynamodb: 'available',
        sqs: 'available',
        sns: 'available',
        s3: 'available',
        lambda: 'available',
        events: 'available',
        sts: 'available',
      },
      edition: 'self',
      version: 'lss-self-engine',
    });
  });
});

// ---------------------------------------------------------------------------
// Routing precedence
// ---------------------------------------------------------------------------

describe('service resolution', () => {
  it('routes by X-Amz-Target prefix without an Authorization header', async () => {
    const res = await request(engine.port, {
      headers: { 'x-amz-target': 'DynamoDB_20120810.PutItem', 'content-type': 'application/x-amz-json-1.0' },
      body: '{"TableName":"users"}',
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, service: 'dynamodb', operation: 'PutItem' });
    expect(res.headers['content-type']).toBe('application/x-amz-json-1.0');
    expect(res.headers['x-amzn-requestid']).toBeDefined();
    expect(engine.dynamo.calls[0].operation).toBe('PutItem');
    expect(engine.dynamo.calls[0].input).toEqual({ TableName: 'users' });
    expect(engine.dynamo.calls[0].req.region).toBe('us-east-1');
    expect(engine.dynamo.calls[0].req.service).toBe('dynamodb');
  });

  it('lets the SigV4 credential scope win and carries its region', async () => {
    const res = await request(engine.port, {
      headers: { authorization: auth('sqs', 'sa-east-1'), 'x-amz-target': 'AmazonSQS.SendMessage' },
      body: '{"QueueUrl":"q"}',
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, service: 'sqs', operation: 'SendMessage' });
    expect(engine.sqs.calls[0].req.region).toBe('sa-east-1');
  });

  it('routes AWSEvents targets with JSON 1.1 framing', async () => {
    const res = await request(engine.port, {
      headers: { 'x-amz-target': 'AWSEvents.PutEvents', 'content-type': 'application/x-amz-json-1.1' },
      body: '{"Entries":[]}',
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/x-amz-json-1.1');
    expect(engine.events.calls[0].operation).toBe('PutEvents');
  });

  it('resolves presigned URLs via X-Amz-Credential', async () => {
    const res = await request(engine.port, {
      method: 'GET',
      path: '/bucket/key.txt?X-Amz-Credential=test%2F20260710%2Feu-west-1%2Fs3%2Faws4_request&X-Amz-Signature=x',
    });
    expect(res.status).toBe(200);
    expect(engine.s3.requests[0].region).toBe('eu-west-1');
    expect(engine.s3.requests[0].rawPath).toBe('/bucket/key.txt');
    expect(engine.s3.requests[0].query['X-Amz-Signature']).toBe('x');
  });

  it('parses an empty JSON body as {}', async () => {
    await request(engine.port, { headers: { 'x-amz-target': 'DynamoDB_20120810.ListTables' } });
    expect(engine.dynamo.calls[0].input).toEqual({});
  });

  it('routes root form posts with Action=GetCallerIdentity to STS', async () => {
    const res = await request(engine.port, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'Action=GetCallerIdentity&Version=2011-06-15',
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/xml');
    expect(res.text).toContain('<GetCallerIdentityResponse');
    expect(engine.sts.calls[0].action).toBe('GetCallerIdentity');
  });

  it('routes other root form posts to SNS and prepends the XML declaration', async () => {
    const res = await request(engine.port, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'Action=Publish&TopicArn=arn%3Aaws%3Asns%3Aus-east-1%3A000000000000%3At',
    });
    expect(res.status).toBe(200);
    expect(res.text.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(res.text).toContain('<PublishResponse');
    expect(engine.sns.calls[0].params.TopicArn).toBe('arn:aws:sns:us-east-1:000000000000:t');
  });

  it('routes dated Lambda paths to the lambda emulator', async () => {
    const res = await request(engine.port, {
      path: '/2015-03-31/functions/my-fn/invocations',
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    expect(res.headers['x-amzn-requestid']).toBeDefined();
    expect(engine.lambda.requests[0].rawPath).toBe('/2015-03-31/functions/my-fn/invocations');
  });

  it('defaults to S3 path-style and preserves encoded key segments', async () => {
    const res = await request(engine.port, { method: 'PUT', path: '/bucket/a%2Fb%2Fc', body: 'data' });
    expect(res.status).toBe(200);
    expect(res.headers['x-amz-request-id']).toBeDefined();
    expect(res.headers['x-amz-id-2']).toBeDefined();
    expect(res.headers['x-amzn-requestid']).toBeUndefined();
    expect(engine.s3.requests[0].rawPath).toBe('/bucket/a%2Fb%2Fc');
    expect(engine.s3.requests[0].body.toString()).toBe('data');
  });

  it('peels virtual-host bucket Hosts into path-style', async () => {
    await request(engine.port, {
      method: 'GET',
      path: '/key.txt',
      headers: { host: 'my-bucket.localhost:4566' },
    });
    expect(engine.s3.requests[0].rawPath).toBe('/my-bucket/key.txt');

    await request(engine.port, { method: 'GET', path: '/', headers: { host: 'my-bucket.localhost:4566' } });
    expect(engine.s3.requests[1].rawPath).toBe('/my-bucket');
  });

  it('never peels localhost, 127.* or IP hosts', async () => {
    await request(engine.port, { method: 'GET', path: '/plain', headers: { host: 'localhost:4566' } });
    expect(engine.s3.requests[0].rawPath).toBe('/plain');

    await request(engine.port, { method: 'GET', path: '/plain', headers: { host: '127.0.0.1:4566' } });
    expect(engine.s3.requests[1].rawPath).toBe('/plain');

    await request(engine.port, { method: 'GET', path: '/plain', headers: { host: '10.0.0.5:80' } });
    expect(engine.s3.requests[2].rawPath).toBe('/plain');
  });
});

// ---------------------------------------------------------------------------
// Legacy SQS Query detection
// ---------------------------------------------------------------------------

describe('legacy SQS Query protocol', () => {
  const form = { 'content-type': 'application/x-www-form-urlencoded' };

  it('answers form posts on QueueUrl paths with the InvalidAction guidance', async () => {
    const res = await request(engine.port, {
      path: '/000000000000/my-queue',
      headers: form,
      body: 'Action=SendMessage&MessageBody=hi',
    });
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toBe('text/xml');
    expect(res.text).toContain('<ErrorResponse>');
    expect(res.text).toContain('<Code>InvalidAction</Code>');
    expect(res.text).toContain('predates the SQS JSON protocol');
    expect(res.text).toContain('selfEngine.fallbackEndpoint');
  });

  it('detects sqs-scoped Query posts on any path', async () => {
    const res = await request(engine.port, {
      path: '/',
      headers: { ...form, authorization: auth('sqs') },
      body: 'Action=CreateQueue&QueueName=q',
    });
    expect(res.status).toBe(400);
    expect(res.text).toContain('<Code>InvalidAction</Code>');
    expect(engine.sqs.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Error serialization per protocol
// ---------------------------------------------------------------------------

describe('error serialization', () => {
  it('serializes JSON errors with the namespaced __type', async () => {
    const res = await request(engine.port, {
      headers: { 'x-amz-target': 'DynamoDB_20120810.FailAws' },
      body: '{}',
    });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({
      __type: 'com.amazonaws.dynamodb.v20120810#ResourceNotFoundException',
      message: 'Requested resource not found',
    });
    expect(res.headers['x-amzn-query-error']).toBeUndefined();
  });

  it('spreads extra error fields into the JSON payload', async () => {
    const res = await request(engine.port, {
      headers: { 'x-amz-target': 'DynamoDB_20120810.FailExtra' },
      body: '{}',
    });
    expect(res.json.__type).toBe('TransactionCanceledException');
    expect(res.json.CancellationReasons).toEqual([{ Code: 'ConditionalCheckFailed' }]);
  });

  it('adds the x-amzn-query-error header on SQS errors', async () => {
    const res = await request(engine.port, {
      headers: { 'x-amz-target': 'AmazonSQS.FailQueue' },
      body: '{}',
    });
    expect(res.status).toBe(400);
    expect(res.headers['x-amzn-query-error']).toBe('QueueNameExists;Sender');
    expect(res.json).toEqual({ __type: 'QueueNameExists', message: 'A queue already exists with the same name' });
  });

  it('rejects unparseable JSON bodies with SerializationException', async () => {
    const res = await request(engine.port, {
      headers: { 'x-amz-target': 'DynamoDB_20120810.PutItem' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
    expect(res.json.__type).toBe('SerializationException');
  });

  it('serializes Query errors as an ErrorResponse document', async () => {
    const res = await request(engine.port, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'Action=Fail',
    });
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toBe('text/xml');
    expect(res.text).toContain('<ErrorResponse><Error><Type>Sender</Type><Code>NotFound</Code>');
    expect(res.text).toContain('<Message>Topic does not exist</Message>');
    expect(res.text).toMatch(/<RequestId>[0-9a-f-]{36}<\/RequestId>/);
  });

  it('answers a Query request without Action with MissingAction', async () => {
    const res = await request(engine.port, { headers: { authorization: auth('sns') }, body: '' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('<Code>MissingAction</Code>');
  });

  it('serializes S3 errors as the bare Error document with the s3 id pair', async () => {
    const res = await request(engine.port, { method: 'GET', path: '/bucket/missing' });
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toBe('application/xml');
    expect(res.headers['x-amz-request-id']).toBeDefined();
    expect(res.headers['x-amz-id-2']).toBeDefined();
    expect(res.text).toContain('<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message>');
  });

  it('keeps S3 HEAD error responses bodyless', async () => {
    const res = await request(engine.port, { method: 'HEAD', path: '/bucket/missing' });
    expect(res.status).toBe(404);
    expect(res.body.length).toBe(0);
    expect(res.headers['content-length']).toBe('0');
  });

  it('serializes Lambda errors as {Type, message} with x-amzn-ErrorType', async () => {
    const res = await request(engine.port, { path: '/2015-03-31/functions/conflict', body: '{}' });
    expect(res.status).toBe(409);
    expect(res.headers['x-amzn-errortype']).toBe('ResourceConflictException');
    expect(res.json).toEqual({ Type: 'User', message: 'Function already exists' });
  });

  it('maps unexpected exceptions to 500 InternalFailure and logs the stack', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(engine.port, {
      headers: { 'x-amz-target': 'DynamoDB_20120810.Crash' },
      body: '{}',
    });
    expect(res.status).toBe(500);
    expect(res.json.__type).toBe('InternalFailure');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('unexpected error'), expect.stringContaining('kaput'));
    errorSpy.mockRestore();
  });

  it('omits Content-Length on 204 responses', async () => {
    const res = await request(engine.port, { method: 'DELETE', path: '/bucket/key' });
    expect(res.status).toBe(204);
    expect(res.headers['content-length']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// aws-chunked uploads
// ---------------------------------------------------------------------------

describe('aws-chunked request bodies', () => {
  it('decodes signed aws-chunked PutObject bodies before dispatch', async () => {
    const chunk = (data: string): string => `${data.length.toString(16)};chunk-signature=${'ab'.repeat(32)}\r\n${data}\r\n`;
    const body =
      chunk('Hello ') + chunk('world') + `0;chunk-signature=${'ab'.repeat(32)}\r\nx-amz-checksum-crc32:sOO8/Q==\r\n\r\n`;
    const res = await request(engine.port, {
      method: 'PUT',
      path: '/bucket/key.txt',
      headers: {
        'content-encoding': 'aws-chunked',
        'x-amz-content-sha256': 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER',
        'x-amz-decoded-content-length': '11',
        'x-amz-trailer': 'x-amz-checksum-crc32',
      },
      body,
    });
    expect(res.status).toBe(200);
    const seen = engine.s3.requests[0];
    expect(seen.body.toString('utf8')).toBe('Hello world');
    expect(seen.headers['content-length']).toBe('11');
    expect(seen.headers['content-encoding']).toBeUndefined();
    expect(seen.headers['x-amz-trailer']).toBeUndefined();
    expect(seen.headers['x-amz-decoded-content-length']).toBeUndefined();
  });

  it('serializes a malformed chunked body as an S3 IncompleteBody error', async () => {
    const res = await request(engine.port, {
      method: 'PUT',
      path: '/bucket/key.txt',
      headers: { 'content-encoding': 'aws-chunked' },
      body: 'zz\r\nnope',
    });
    expect(res.status).toBe(400);
    expect(res.text).toContain('<Code>IncompleteBody</Code>');
  });
});

// ---------------------------------------------------------------------------
// Unknown services/operations and the fallback proxy
// ---------------------------------------------------------------------------

describe('unknown operations without a fallback', () => {
  it('rejects unknown X-Amz-Target prefixes with a JSON 400 naming the coverage doc', async () => {
    const res = await request(engine.port, {
      headers: { 'x-amz-target': 'Kinesis_20131202.PutRecord', 'content-type': 'application/x-amz-json-1.1' },
      body: '{}',
    });
    expect(res.status).toBe(400);
    expect(res.json.__type).toBe('NotImplemented');
    expect(res.json.message).toContain('docs/SELF_ENGINE.md#coverage');
    expect(res.json.message).toContain('Kinesis_20131202.PutRecord');
  });

  it('rejects scope-resolved services the engine does not emulate', async () => {
    const res = await request(engine.port, {
      headers: {
        authorization: auth('secretsmanager'),
        'x-amz-target': 'secretsmanager.GetSecretValue',
        'content-type': 'application/x-amz-json-1.1',
      },
      body: '{}',
    });
    expect(res.status).toBe(400);
    expect(res.json.__type).toBe('NotImplemented');
    expect(res.json.message).toContain('secretsmanager');
  });

  it('maps a TargetEmulator UnknownOperationException to the same explicit 400', async () => {
    const res = await request(engine.port, {
      headers: { 'x-amz-target': 'DynamoDB_20120810.UnknownOp' },
      body: '{}',
    });
    expect(res.status).toBe(400);
    expect(res.json.__type).toBe('NotImplemented');
    expect(res.json.message).toContain('dynamodb.UnknownOp');
  });

  it('rejects a JSON-protocol service hit without X-Amz-Target', async () => {
    const res = await request(engine.port, { headers: { authorization: auth('dynamodb') }, body: '{}' });
    expect(res.status).toBe(400);
    expect(res.json.__type).toBe('NotImplemented');
  });
});

describe('fallback proxy', () => {
  interface StubHit {
    method?: string;
    url?: string;
    headers: http.IncomingHttpHeaders;
    body: Buffer;
  }
  let stub: http.Server;
  let stubPort: number;
  let hits: StubHit[];
  let proxied: Engine;

  beforeEach(async () => {
    hits = [];
    stub = http.createServer((sreq, sres) => {
      const chunks: Buffer[] = [];
      sreq.on('data', chunk => chunks.push(chunk as Buffer));
      sreq.on('end', () => {
        hits.push({ method: sreq.method, url: sreq.url, headers: sreq.headers, body: Buffer.concat(chunks) });
        sres.writeHead(418, { 'x-stub': 'yes', 'content-type': 'application/json' });
        sres.end('{"stub":true}');
      });
    });
    await new Promise<void>(resolve => stub.listen(0, '127.0.0.1', resolve));
    stubPort = (stub.address() as AddressInfo).port;
    proxied = await startEngine({ fallbackEndpoint: `http://127.0.0.1:${stubPort}` });
  });

  afterEach(async () => {
    await proxied.close();
    await new Promise<void>(resolve => stub.close(() => resolve()));
  });

  it('proxies unknown services verbatim and streams the response back', async () => {
    const res = await request(proxied.port, {
      path: '/?foo=bar',
      headers: {
        authorization: auth('kinesis'),
        'x-amz-target': 'Kinesis_20131202.PutRecord',
        'x-custom': 'kept',
        'content-type': 'application/x-amz-json-1.1',
      },
      body: '{"StreamName":"s"}',
    });
    expect(res.status).toBe(418);
    expect(res.headers['x-stub']).toBe('yes');
    expect(res.text).toBe('{"stub":true}');
    expect(hits).toHaveLength(1);
    expect(hits[0].method).toBe('POST');
    expect(hits[0].url).toBe('/?foo=bar');
    expect(hits[0].headers['x-custom']).toBe('kept');
    expect(hits[0].headers['authorization']).toBe(auth('kinesis'));
    expect(hits[0].headers.host).toBe(`127.0.0.1:${stubPort}`);
    expect(hits[0].body.toString('utf8')).toBe('{"StreamName":"s"}');
  });

  it('forwards the raw pre-decode body for aws-chunked requests', async () => {
    const raw = `6;chunk-signature=${'ab'.repeat(32)}\r\nHello \r\n0;chunk-signature=${'ab'.repeat(32)}\r\n\r\n`;
    await request(proxied.port, {
      method: 'PUT',
      path: '/whatever',
      headers: {
        authorization: auth('kinesis'),
        'x-amz-target': 'Kinesis_20131202.PutRecord',
        'content-encoding': 'aws-chunked',
      },
      body: raw,
    });
    expect(hits[0].body.toString('utf8')).toBe(raw);
    expect(hits[0].headers['content-encoding']).toBe('aws-chunked');
  });

  it('proxies TargetEmulator UnknownOperationException ops', async () => {
    const res = await request(proxied.port, {
      headers: { 'x-amz-target': 'DynamoDB_20120810.UnknownOp' },
      body: '{}',
    });
    expect(res.status).toBe(418);
    expect(hits).toHaveLength(1);
    expect(hits[0].headers['x-amz-target']).toBe('DynamoDB_20120810.UnknownOp');
  });

  it('proxies legacy SQS Query requests instead of rejecting them', async () => {
    const res = await request(proxied.port, {
      path: '/000000000000/my-queue',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'Action=SendMessage&MessageBody=hi',
    });
    expect(res.status).toBe(418);
    expect(hits[0].url).toBe('/000000000000/my-queue');
    expect(hits[0].body.toString('utf8')).toBe('Action=SendMessage&MessageBody=hi');
  });

  it('answers 502 in the protocol shape when the fallback is unreachable', async () => {
    const dead = await startEngine({ fallbackEndpoint: 'http://127.0.0.1:9' });
    try {
      const res = await request(dead.port, {
        headers: { authorization: auth('kinesis'), 'x-amz-target': 'Kinesis_20131202.PutRecord' },
        body: '{}',
      });
      expect(res.status).toBe(502);
      expect(res.json.__type).toBe('ServiceUnavailable');
      expect(String(res.json.message)).toContain('fallbackEndpoint');
    } finally {
      await dead.close();
    }
  });
});
