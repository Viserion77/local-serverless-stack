// Unit test for the /api/apis route. Mounts the router on a throwaway Express
// app and drives it with supertest. The real FunctionRegistry (reset per test)
// provides the service/route data; GatewayManager and LambdaRuntimeManager are
// jest.mocked (real modules bind ports / fork workers); AuthorizerService's
// clearCache is spied.
import express from 'express';
import request from 'supertest';

jest.mock('../../../src/server/services/lambda-runtime-manager', () => {
  const instance = { invoke: jest.fn() };
  return { LambdaRuntimeManager: { getInstance: () => instance } };
});
jest.mock('../../../src/server/services/gateway-manager', () => {
  const instance = { getInfo: jest.fn() };
  return { GatewayManager: { getInstance: () => instance } };
});

import { apisRouter } from '../../../src/server/routes/apis';
import { FunctionRegistry } from '../../../src/server/services/function-registry';
import { GatewayManager } from '../../../src/server/services/gateway-manager';
import { AuthorizerService } from '../../../src/server/services/authorizer-service';

const gateway = GatewayManager.getInstance() as jest.Mocked<GatewayManager>;

function appWith() {
  const app = express();
  app.use(express.json());
  app.use('/api/apis', apisRouter);
  return app;
}

beforeEach(() => {
  (FunctionRegistry as any).instance = undefined;
  gateway.getInfo.mockReset();
  gateway.getInfo.mockReturnValue({
    api: { port: 3001, status: 'online' },
    invoke: { port: 13001, status: 'port-conflict' },
  } as never);
});

afterEach(() => jest.restoreAllMocks());

describe('GET /api/apis', () => {
  it('groups routes and authorizers by service with gateway status and payload versions', async () => {
    FunctionRegistry.getInstance().registerService({
      name: 'svc-a',
      root: '/abs/svc-a',
      templateHash: 'h',
      lastUpdated: 1,
      status: 'registered',
      apiPort: 3001,
      invokePort: 13001,
      stage: 'offline',
      routes: [
        { functionName: 'users', method: 'GET', path: '/users', eventType: 'http', cors: true, authorizerName: 'users:auth' },
        { functionName: 'items', method: 'ANY', path: '$default', eventType: 'httpApi', cors: false },
      ],
      authorizers: [
        {
          name: 'users:auth',
          type: 'token',
          eventType: 'http',
          payloadVersion: '1.0',
          enableSimpleResponses: false,
          identitySource: ['method.request.header.Authorization'],
          resultTtlInSeconds: 300,
          functionName: 'auth',
          arn: undefined,
        },
      ],
    });
    // Routeless but with an apiPort → still listed (the gateway may bind it).
    FunctionRegistry.getInstance().registerService({
      name: 'svc-b',
      root: '/abs/svc-b',
      templateHash: 'h',
      lastUpdated: 1,
      status: 'registered',
      apiPort: 3002,
    });
    // No routes and no apiPort → filtered out.
    FunctionRegistry.getInstance().registerService({
      name: 'svc-c',
      root: '/abs/svc-c',
      templateHash: 'h',
      lastUpdated: 1,
      status: 'registered',
    });

    const res = await request(appWith()).get('/api/apis');

    expect(res.status).toBe(200);
    expect(res.body.map((s: any) => s.service)).toEqual(['svc-a', 'svc-b']);
    expect(res.body[0]).toEqual({
      service: 'svc-a',
      apiPort: 3001,
      invokePort: 13001,
      stage: 'offline',
      status: 'online',
      invokeStatus: 'port-conflict',
      routes: [
        {
          method: 'GET',
          path: '/users',
          functionName: 'users',
          eventType: 'http',
          payloadVersion: '1.0',
          cors: true,
          authorizerName: 'users:auth',
        },
        {
          method: 'ANY',
          path: '$default',
          functionName: 'items',
          eventType: 'httpApi',
          payloadVersion: '2.0',
          cors: false,
        },
      ],
      authorizers: [
        {
          name: 'users:auth',
          type: 'token',
          eventType: 'http',
          payloadVersion: '1.0',
          enableSimpleResponses: false,
          identitySource: ['method.request.header.Authorization'],
          resultTtlInSeconds: 300,
          functionName: 'auth',
        },
      ],
    });
    expect(res.body[1].routes).toEqual([]);
  });

  it('returns an empty list when nothing is registered', async () => {
    const res = await request(appWith()).get('/api/apis');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('surfaces a raw cross-stack route with its resolved functionArn and no {proxy+}/$default stand-in', async () => {
    const CROSS_ARN = 'arn:aws:lambda:sa-east-1:000000000000:function:users-service-dev-listUsers';
    FunctionRegistry.getInstance().registerService({
      name: 'gateway-stack',
      root: '/abs/gateway-stack',
      templateHash: 'h',
      lastUpdated: 1,
      status: 'registered',
      apiPort: 3613,
      stage: 'dev',
      // A gateway-only service: no functions of its own, one raw ApiGatewayV2 route.
      routes: [
        {
          functionName: 'users-service-dev-listUsers',
          method: 'GET',
          path: '/gw/users',
          eventType: 'httpApi',
          cors: true,
          authorizerName: 'sessionAuthorizerV2',
          functionArn: CROSS_ARN,
          payloadVersion: '2.0',
          raw: true,
          sourceArn: 'arn:aws:execute-api:sa-east-1:000000000000:gw123/*',
        },
      ],
      authorizers: [
        {
          name: 'sessionAuthorizerV2',
          type: 'request',
          eventType: 'httpApi',
          payloadVersion: '2.0',
          enableSimpleResponses: true,
          identitySource: ['$request.header.authorization'],
          resultTtlInSeconds: 3600,
          arn: 'arn:aws:lambda:sa-east-1:000000000000:function:users-service-dev-sessionAuthorizerV2Local',
        },
      ],
    });

    const res = await request(appWith()).get('/api/apis');

    expect(res.status).toBe(200);
    expect(res.body[0].routes).toEqual([
      {
        method: 'GET',
        path: '/gw/users',
        functionName: 'users-service-dev-listUsers',
        functionArn: CROSS_ARN,
        eventType: 'httpApi',
        payloadVersion: '2.0',
        cors: true,
        authorizerName: 'sessionAuthorizerV2',
        raw: true,
      },
    ]);
    expect(res.body[0].authorizers[0].arn).toContain('sessionAuthorizerV2Local');
    // The raw topology resolved on its own — no catch-all stand-in anywhere.
    const paths = res.body.flatMap((s: any) => s.routes.map((r: any) => r.path));
    expect(paths).not.toContain('/api/{proxy+}');
    expect(paths).not.toContain('$default');
  });
});

describe('POST /api/apis/authorizer-cache/clear', () => {
  it('clears everything when no filters are given', async () => {
    const spy = jest.spyOn(AuthorizerService.getInstance(), 'clearCache').mockReturnValue(4);
    const res = await request(appWith()).post('/api/apis/authorizer-cache/clear');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, removed: 4 });
    expect(spy).toHaveBeenCalledWith({ service: undefined, authorizer: undefined });
  });

  it('threads service/authorizer query filters through', async () => {
    const spy = jest.spyOn(AuthorizerService.getInstance(), 'clearCache').mockReturnValue(1);
    const res = await request(appWith())
      .post('/api/apis/authorizer-cache/clear')
      .query({ service: 'svc-a', authorizer: 'users:auth' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, removed: 1 });
    expect(spy).toHaveBeenCalledWith({ service: 'svc-a', authorizer: 'users:auth' });
  });
});
