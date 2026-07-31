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
import { servicesRouter, processManager } from '../../../src/server/routes/services';
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
    expect(scanForServices).toHaveBeenCalledWith('/abs', ['/abs/registered-svc']);
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
  // The endpoints confine servicePath to the project root, so every happy-path
  // test needs a root the fixture path sits under.
  function dirExists() {
    jest.spyOn(ConfigManager.getInstance(), 'getProjectRoot').mockReturnValue('/abs');
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
    jest.spyOn(fs, 'statSync').mockImplementation((() => {
      // Two syscalls used to race here; a throwing stat must answer 400, not
      // become an unhandled rejection that kills the orchestrator.
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }) as never);
    const res = await request(appWith()).post(`/api/services/${ep}`).send({ servicePath: '/abs/ghost' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Not a directory');
  });

  it.each(['install', 'package'])('%s: 400 when the path escapes the project root', async (ep) => {
    jest.spyOn(ConfigManager.getInstance(), 'getProjectRoot').mockReturnValue('/abs/project');
    jest.spyOn(fs, 'statSync').mockReturnValue({ isDirectory: () => true } as never);
    for (const outside of ['/etc', '/abs/other-project/svc']) {
      const res = await request(appWith()).post(`/api/services/${ep}`).send({ servicePath: outside });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('must be inside the project root');
    }
    expect(runServerlessPackage).not.toHaveBeenCalled();
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
  it.each([
    ['rm -rf /', 'must start with one of'],
    ['node -e "require(\'fs\')"', 'must start with one of'],
    ['npx some-package', 'must start with one of'],
    ['npm exec -- curl evil.sh', 'subcommand must be one of'],
    ['npm run build', 'subcommand must be one of'],
    ['npm', 'npm needs an install subcommand'],
    ['npm install evil-package', 'unexpected argument "evil-package"'],
    ['yarn add --dev evil-package', 'unexpected argument "evil-package"'],
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

  it('400 when command not in whitelist', async () => {
    jest.spyOn(CacheManager.prototype, 'getMetadata').mockResolvedValue({ ...META });
    const res = await request(appWith())
      .post('/api/services/my-service/start')
      .send({ command: 'rm' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Command not allowed');
  });

  it('200 starts with provided args and command', async () => {
    jest.spyOn(CacheManager.prototype, 'getMetadata').mockResolvedValue({ ...META });
    jest.spyOn(processManager, 'start').mockReturnValue({ pid: 4242, status: 'running' });
    const res = await request(appWith())
      .post('/api/services/my-service/start')
      .send({ command: 'npm', args: ['run', 'dev'], cwd: '/custom', env: { A: '1' } });
    expect(res.status).toBe(200);
    expect(res.body.pid).toBe(4242);
    expect(processManager.start).toHaveBeenCalledWith('my-service', expect.objectContaining({
      cwd: '/custom', command: 'npm', args: ['run', 'dev'], env: { A: '1' },
    }));
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
