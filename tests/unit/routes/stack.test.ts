// Unit test for the /api/stack route. Mounts the router on a throwaway Express
// app and drives it with supertest; the CacheManager is a module-level instance,
// so its prototype is spied (the instance delegates to it). The builders run for
// real — the route's job is to feed them, and that is what is asserted.
import express from 'express';
import request from 'supertest';
import { stackRouter } from '../../../src/server/routes/stack';
import { CacheManager } from '../../../src/server/services/cache-manager';

function appWith() {
  const app = express();
  app.use('/api/stack', stackRouter);
  return app;
}

const ORDERS_TEMPLATE = {
  Resources: {
    Jobs: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'orders-jobs' } },
  },
};

const BILLING_TEMPLATE = {
  Resources: {
    ProcessLambdaFunction: { Type: 'AWS::Lambda::Function', Properties: { FunctionName: 'billing-dev-process', Handler: 'h.handler' } },
    Mapping: {
      Type: 'AWS::Lambda::EventSourceMapping',
      Properties: { FunctionName: { Ref: 'ProcessLambdaFunction' }, EventSourceArn: 'arn:aws:sqs:us-west-2:000000000000:orders-jobs' },
    },
  },
};

describe('GET /api/stack/graph', () => {
  afterEach(() => jest.restoreAllMocks());

  function mockCache(templates: Record<string, unknown>) {
    jest.spyOn(CacheManager.prototype, 'init').mockResolvedValue(undefined);
    jest.spyOn(CacheManager.prototype, 'listServices').mockResolvedValue(
      Object.keys(templates).map(name => ({
        name,
        region: 'us-west-2',
        functions: name === 'billing'
          ? [{ name: 'process', fullName: 'billing-dev-process', handler: 'h.handler', runtime: 'nodejs20.x', memorySize: 1024, timeout: 6, environment: {}, triggers: [] }]
          : undefined,
      }) as any),
    );
    jest.spyOn(CacheManager.prototype, 'getTemplate').mockImplementation(async (name: string) => templates[name] ?? null);
  }

  it('joins every registered service and resolves the cross-service reference', async () => {
    mockCache({ orders: ORDERS_TEMPLATE, billing: BILLING_TEMPLATE });
    const res = await request(appWith()).get('/api/stack/graph');

    expect(res.status).toBe(200);
    // Two services: under the threshold, so both are expanded by default.
    expect(res.body.expanded).toEqual(['billing', 'orders']);
    expect(res.body.edges).toEqual([
      expect.objectContaining({
        from: 'orders/sqs:Jobs',
        to: 'billing/lambda:ProcessLambdaFunction',
        kind: 'cross-service',
        via: 'event-source',
      }),
    ]);
    expect(res.body.nodes.map((n: { label: string }) => n.label).sort()).toEqual(['orders-jobs', 'process']);
  });

  it('honours ?expand= (collapsing everything else)', async () => {
    mockCache({ orders: ORDERS_TEMPLATE, billing: BILLING_TEMPLATE });
    const res = await request(appWith()).get('/api/stack/graph?expand=billing');

    expect(res.status).toBe(200);
    expect(res.body.expanded).toEqual(['billing']);
    expect(res.body.nodes.map((n: { id: string }) => n.id)).toEqual(['billing/lambda:ProcessLambdaFunction', 'service:orders']);
    expect(res.body.edges[0]).toMatchObject({ from: 'service:orders', to: 'billing/lambda:ProcessLambdaFunction', weight: 1 });
  });

  it('keeps a registered service with no cached template, with the reason as a warning', async () => {
    mockCache({ orders: ORDERS_TEMPLATE, ghost: null });
    const res = await request(appWith()).get('/api/stack/graph?expand=');

    expect(res.status).toBe(200);
    expect(res.body.nodes.map((n: { id: string }) => n.id)).toEqual(['service:ghost', 'service:orders']);
    expect(res.body.warnings).toEqual(['[ghost] No cached CloudFormation template for this service']);
  });

  it('answers 500 when the cache cannot be read', async () => {
    jest.spyOn(CacheManager.prototype, 'init').mockResolvedValue(undefined);
    jest.spyOn(CacheManager.prototype, 'listServices').mockRejectedValue(new Error('disk gone'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(appWith()).get('/api/stack/graph');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to build stack graph' });
  });
});
