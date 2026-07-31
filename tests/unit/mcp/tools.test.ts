// Each tool maps to exactly one orchestrator endpoint. These tests pin the
// method + path + body, because a wrong path here is invisible until a model
// calls the tool against a live stack.
import { TOOLS, TOOLS_BY_NAME, toolListPayload } from '../../../src/mcp/tools';

function call(name: string, args: Record<string, unknown> = {}) {
  const http = jest.fn(async () => ({ ok: true }));
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  // Normalised to a rejection the way the protocol layer sees it: `callTool`
  // awaits `run` inside its try/catch, so an argument check that throws
  // synchronously and one that rejects are the same outcome to a client.
  return { promise: Promise.resolve().then(() => tool.run(args, http)), http };
}

async function expectCall(name: string, args: Record<string, unknown>, expected: unknown[]) {
  const { promise, http } = call(name, args);
  await promise;
  expect(http).toHaveBeenCalledWith(...expected);
}

describe('tool catalogue', () => {
  it('names are unique, prefixed and snake_case', () => {
    const names = TOOLS.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^lss_[a-z0-9_]+$/);
  });

  it('every mutating tool announces it in its description', () => {
    for (const tool of TOOLS.filter(t => t.mutates)) {
      expect(tool.description).toContain('MUTATES');
    }
  });

  it('required properties are always declared in the schema', () => {
    for (const tool of TOOLS) {
      for (const key of tool.inputSchema.required ?? []) {
        expect(Object.keys(tool.inputSchema.properties)).toContain(key);
      }
    }
  });

  it('toolListPayload strips the server-side runner', () => {
    for (const entry of toolListPayload() as Record<string, unknown>[]) {
      expect(Object.keys(entry).sort()).toEqual(['description', 'inputSchema', 'name']);
    }
  });
});

describe('read-only tools', () => {
  it('maps each to its endpoint', async () => {
    await expectCall('lss_health', {}, ['GET', '/api/health']);
    await expectCall('lss_config', {}, ['GET', '/api/config']);
    await expectCall('lss_ports', {}, ['GET', '/api/config/ports']);
    await expectCall('lss_services', {}, ['GET', '/api/services']);
    await expectCall('lss_lambdas', {}, ['GET', '/api/lambdas']);
    await expectCall('lss_apis', {}, ['GET', '/api/apis']);
    await expectCall('lss_resources', {}, ['GET', '/api/resources']);
    await expectCall('lss_resource_owners', {}, ['GET', '/api/resources/owners']);
    await expectCall('lss_dynamo_tables', {}, ['GET', '/api/dynamo/tables']);
    await expectCall('lss_queues', {}, ['GET', '/api/queues']);
    await expectCall('lss_buckets', {}, ['GET', '/api/buckets']);
    await expectCall('lss_secrets', {}, ['GET', '/api/secrets']);
    await expectCall('lss_seeds', {}, ['GET', '/api/seeds']);
  });

  it('appends ?region= only when a region is given', async () => {
    await expectCall('lss_resources', { region: 'sa-east-1' }, ['GET', '/api/resources?region=sa-east-1']);
    await expectCall('lss_resources', { region: '' }, ['GET', '/api/resources']);
    await expectCall('lss_resources', { region: 7 }, ['GET', '/api/resources']);
  });

  it('encodes names so a slash in a secret or function name cannot escape the path', async () => {
    await expectCall('lss_lambda_logs', { name: 'a/b' }, ['GET', '/api/lambdas/a%2Fb/logs']);
  });

  it('rejects a missing or non-string required name', async () => {
    await expect(call('lss_lambda_logs', {}).promise).rejects.toThrow('"name" is required');
    await expect(call('lss_dynamo_scan', { table: 5 }).promise).rejects.toThrow('"table" is required');
  });
});

describe('dynamo tools', () => {
  it('scan and query post the input through, defaulting scan input to {}', async () => {
    await expectCall('lss_dynamo_scan', { table: 'Users' }, ['POST', '/api/dynamo/tables/Users/scan', {}]);
    await expectCall(
      'lss_dynamo_scan',
      { table: 'Users', input: { limit: 5 }, region: 'eu-west-1' },
      ['POST', '/api/dynamo/tables/Users/scan?region=eu-west-1', { limit: 5 }],
    );
    await expectCall(
      'lss_dynamo_query',
      { table: 'Orders', input: { keyConditionExpression: '#pk = :pk' } },
      ['POST', '/api/dynamo/tables/Orders/query', { keyConditionExpression: '#pk = :pk' }],
    );
    await expectCall('lss_dynamo_query', { table: 'Orders' }, ['POST', '/api/dynamo/tables/Orders/query', {}]);
  });

  it('put_item wraps the plain item the API expects', async () => {
    await expectCall(
      'lss_dynamo_put_item',
      { table: 'Users', item: { id: 'u-1' } },
      ['POST', '/api/dynamo/tables/Users/items', { item: { id: 'u-1' } }],
    );
  });
});

describe('queue tools', () => {
  it('send passes FIFO fields through', async () => {
    await expectCall(
      'lss_queue_send',
      { queue: 'q.fifo', body: 'hi', messageGroupId: 'g', messageDeduplicationId: 'd', delaySeconds: 2 },
      ['POST', '/api/queues/q.fifo/messages', {
        body: 'hi', messageGroupId: 'g', messageDeduplicationId: 'd', delaySeconds: 2,
      }],
    );
  });

  it('await_idle forwards the wait budget and the processed threshold', async () => {
    await expectCall(
      'lss_queue_await_idle',
      { queue: 'orders', timeoutMs: 30000, sinceProcessed: 1 },
      ['POST', '/api/queues/orders/await-idle', { timeoutMs: 30000, sinceProcessed: 1 }],
    );
    await expectCall('lss_queue_await_idle', { queue: 'orders' }, [
      'POST', '/api/queues/orders/await-idle', { timeoutMs: undefined, sinceProcessed: undefined },
    ]);
  });
});

describe('invoke', () => {
  it('defaults to a synchronous invocation with an empty event', async () => {
    await expectCall('lss_invoke', { name: 'createOrder' }, [
      'POST', '/api/lambdas/createOrder/invoke', { payload: {}, invocationType: 'RequestResponse' },
    ]);
  });

  it('async switches to the Event invocation type', async () => {
    await expectCall('lss_invoke', { name: 'fn', payload: { a: 1 }, async: true }, [
      'POST', '/api/lambdas/fn/invoke', { payload: { a: 1 }, invocationType: 'Event' },
    ]);
  });
});

describe('bucket objects', () => {
  it('builds the query string from prefix, delimiter and region', async () => {
    await expectCall('lss_bucket_objects', { bucket: 'b' }, ['GET', '/api/buckets/b/objects']);
    await expectCall(
      'lss_bucket_objects',
      { bucket: 'b', prefix: 'incoming/', delimiter: '/', region: 'us-west-2' },
      ['GET', '/api/buckets/b/objects?prefix=incoming%2F&delimiter=%2F&region=us-west-2'],
    );
    // Empty strings and wrong types are dropped rather than sent as blanks.
    await expectCall('lss_bucket_objects', { bucket: 'b', prefix: '', delimiter: 3, region: '' }, [
      'GET', '/api/buckets/b/objects',
    ]);
  });
});

describe('opensearch and seeds', () => {
  it('search forwards index and body, defaulting body to {}', async () => {
    await expectCall('lss_opensearch_search', { collection: 'c', index: 'i', body: { size: 1 } }, [
      'POST', '/api/opensearch/collections/c/search', { index: 'i', body: { size: 1 } },
    ]);
    await expectCall('lss_opensearch_search', { collection: 'c' }, [
      'POST', '/api/opensearch/collections/c/search', { index: undefined, body: {} },
    ]);
  });

  it('seed_run targets one table or all of them', async () => {
    await expectCall('lss_seed_run', {}, ['POST', '/api/seeds/run', {}]);
    await expectCall('lss_seed_run', { table: '' }, ['POST', '/api/seeds/run', {}]);
    await expectCall('lss_seed_run', { table: 'Users', region: 'us-east-2' }, [
      'POST', '/api/seeds/run?region=us-east-2', { tableName: 'Users' },
    ]);
  });
});
