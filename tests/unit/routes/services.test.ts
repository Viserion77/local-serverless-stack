// Unit test for the /api/services route. Mounts the router on a throwaway
// Express app and drives it with supertest. fs/promises and the serverless
// packager are jest.mocked; the CacheManager / ResourceProvisioner / parser /
// processManager are spied on their prototypes so the router's own instances
// are intercepted.
import express from 'express';
import request from 'supertest';
import path from 'path';

jest.mock('fs/promises');
// Mock only runServerlessPackage; keep the real ServerlessPackageError class so
// `instanceof` checks and `.result` access in the handler work correctly.
jest.mock('../../../src/server/services/serverless-packager', () => ({
  ...jest.requireActual('../../../src/server/services/serverless-packager'),
  runServerlessPackage: jest.fn(),
}));

import fs from 'fs/promises';
import { servicesRouter, processManager } from '../../../src/server/routes/services';
import { CacheManager } from '../../../src/server/services/cache-manager';
import { ResourceProvisioner } from '../../../src/server/services/resource-provisioner';
import { ConfigManager } from '../../../src/server/services/config-manager';
import {
  runServerlessPackage,
  ServerlessPackageError,
} from '../../../src/server/services/serverless-packager';

const mockedFs = fs as jest.Mocked<typeof fs>;
const mockedRunPackage = runServerlessPackage as jest.MockedFunction<typeof runServerlessPackage>;

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
    // An event-source mapping yields a resource with `functionName` (not `name`),
    // exercising the `'name' in r ? r.name : r.functionName` fallback arm.
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

beforeEach(() => {
  jest.restoreAllMocks();
  mockedFs.mkdir.mockReset();
  mockedFs.readFile.mockReset();
  mockedRunPackage.mockReset();
  mockedFs.mkdir.mockResolvedValue(undefined as any);

  // Stable defaults for the provisioner and cache so each handler can run.
  const prov = ResourceProvisioner.getInstance();
  jest.spyOn(prov, 'provisionResources').mockResolvedValue(undefined as any);
  jest.spyOn(prov, 'cleanupResources').mockResolvedValue(undefined as any);

  jest.spyOn(CacheManager.prototype, 'init').mockResolvedValue(undefined);
  jest.spyOn(CacheManager.prototype, 'saveTemplate').mockResolvedValue(undefined);
  jest.spyOn(CacheManager.prototype, 'updateMetadata').mockResolvedValue(undefined);
  jest.spyOn(CacheManager.prototype, 'deleteService').mockResolvedValue(undefined);

  const cm = ConfigManager.getInstance();
  jest.spyOn(cm, 'getConfig').mockReturnValue({ region: undefined } as any);
  jest.spyOn(cm, 'isAutoPackage').mockReturnValue(false);
  jest.spyOn(cm, 'getPackageCommand').mockReturnValue('npx serverless package');
  jest.spyOn(cm, 'getPackageTimeoutMs').mockReturnValue(300000);
});

describe('POST /api/services/register', () => {
  it('400 when servicePath is missing', async () => {
    const res = await request(appWith()).post('/api/services/register').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('servicePath is required');
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

  it('400 on invalid invokePort', async () => {
    const res = await request(appWith())
      .post('/api/services/register')
      .send({ servicePath: '/abs/svc', invokePort: 80 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid invokePort, must be between 1024-65535');
  });

  it('registers when template is present (region from request, invokePort valid)', async () => {
    mockedFs.readFile.mockResolvedValue(JSON.stringify(TEMPLATE));
    const res = await request(appWith())
      .post('/api/services/register')
      .send({ servicePath: '/abs/my-service', invokePort: 4000, region: 'eu-west-1' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.serviceName).toBe('my-service');
    expect(res.body.resourcesCount).toBe(6);
    expect(res.body.resources.map((r: any) => r.type).sort()).toEqual(
      ['dynamodb', 'event-source', 'lambda', 's3', 'sns', 'sqs'],
    );
    // The event-source resource exposes functionName rather than name.
    expect(res.body.resources.find((r: any) => r.type === 'event-source').name).toBe('my-fn');
  });

  it('uses lss.config.json region when request omits region', async () => {
    (ConfigManager.getInstance().getConfig as jest.Mock).mockReturnValue({ region: 'ap-south-1' });
    mockedFs.readFile.mockResolvedValue(JSON.stringify(TEMPLATE));
    const res = await request(appWith())
      .post('/api/services/register')
      .send({ servicePath: '/abs/my-service' });
    expect(res.status).toBe(200);
  });

  it('falls back to default region when none configured', async () => {
    mockedFs.readFile.mockResolvedValue(JSON.stringify(TEMPLATE));
    const res = await request(appWith())
      .post('/api/services/register')
      .send({ servicePath: '/abs/my-service' });
    expect(res.status).toBe(200);
  });

  it('400 when template missing and autoPackage disabled (ENOENT)', async () => {
    const enoent: NodeJS.ErrnoException = new Error('nope');
    enoent.code = 'ENOENT';
    mockedFs.readFile.mockRejectedValue(enoent);
    const res = await request(appWith())
      .post('/api/services/register')
      .send({ servicePath: '/abs/my-service' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('CloudFormation template not found');
  });

  it('rethrows non-ENOENT read errors (caught by outer 500 handler)', async () => {
    mockedFs.readFile.mockRejectedValue(new Error('EACCES boom'));
    const res = await request(appWith())
      .post('/api/services/register')
      .send({ servicePath: '/abs/my-service' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('EACCES boom');
  });

  it('auto-packages then retries readFile successfully (with stdout printed)', async () => {
    const enoent: NodeJS.ErrnoException = new Error('nope');
    enoent.code = 'ENOENT';
    (ConfigManager.getInstance().isAutoPackage as jest.Mock).mockReturnValue(true);
    mockedFs.readFile
      .mockRejectedValueOnce(enoent)
      .mockResolvedValueOnce(JSON.stringify(TEMPLATE));
    mockedRunPackage.mockResolvedValue({ exitCode: 0, stdout: 'built it\n', stderr: '' });
    const res = await request(appWith())
      .post('/api/services/register')
      .send({ servicePath: '/abs/my-service' });
    expect(res.status).toBe(200);
    expect(mockedRunPackage).toHaveBeenCalled();
  });

  it('auto-packages with empty stdout (skips stdout log branch)', async () => {
    const enoent: NodeJS.ErrnoException = new Error('nope');
    enoent.code = 'ENOENT';
    (ConfigManager.getInstance().isAutoPackage as jest.Mock).mockReturnValue(true);
    mockedFs.readFile
      .mockRejectedValueOnce(enoent)
      .mockResolvedValueOnce(JSON.stringify(TEMPLATE));
    mockedRunPackage.mockResolvedValue({ exitCode: 0, stdout: '   ', stderr: '' });
    const res = await request(appWith())
      .post('/api/services/register')
      .send({ servicePath: '/abs/my-service' });
    expect(res.status).toBe(200);
  });

  it('500 on ServerlessPackageError with stdout+stderr present', async () => {
    const enoent: NodeJS.ErrnoException = new Error('nope');
    enoent.code = 'ENOENT';
    (ConfigManager.getInstance().isAutoPackage as jest.Mock).mockReturnValue(true);
    mockedFs.readFile.mockRejectedValueOnce(enoent);
    mockedRunPackage.mockRejectedValue(
      new ServerlessPackageError('exit 1', { exitCode: 1, stdout: 'out\n', stderr: 'err\n' }),
    );
    const res = await request(appWith())
      .post('/api/services/register')
      .send({ servicePath: '/abs/my-service' });
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('Auto-package failed');
    expect(res.body.error).toContain('err');
  });

  it('500 on ServerlessPackageError with empty stdout/stderr (uses stdout fallback in detail)', async () => {
    const enoent: NodeJS.ErrnoException = new Error('nope');
    enoent.code = 'ENOENT';
    (ConfigManager.getInstance().isAutoPackage as jest.Mock).mockReturnValue(true);
    mockedFs.readFile.mockRejectedValueOnce(enoent);
    mockedRunPackage.mockRejectedValue(
      new ServerlessPackageError('exit 1', { exitCode: 1, stdout: '', stderr: '' }),
    );
    const res = await request(appWith())
      .post('/api/services/register')
      .send({ servicePath: '/abs/my-service' });
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('Auto-package failed');
  });

  it('500 on non-ServerlessPackageError thrown by runServerlessPackage (Error)', async () => {
    const enoent: NodeJS.ErrnoException = new Error('nope');
    enoent.code = 'ENOENT';
    (ConfigManager.getInstance().isAutoPackage as jest.Mock).mockReturnValue(true);
    mockedFs.readFile.mockRejectedValueOnce(enoent);
    mockedRunPackage.mockRejectedValue(new Error('spawn failed'));
    const res = await request(appWith())
      .post('/api/services/register')
      .send({ servicePath: '/abs/my-service' });
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('spawn failed');
  });

  it('500 on non-Error thrown by runServerlessPackage (Unknown error)', async () => {
    const enoent: NodeJS.ErrnoException = new Error('nope');
    enoent.code = 'ENOENT';
    (ConfigManager.getInstance().isAutoPackage as jest.Mock).mockReturnValue(true);
    mockedFs.readFile.mockRejectedValueOnce(enoent);
    mockedRunPackage.mockRejectedValue('a string failure');
    const res = await request(appWith())
      .post('/api/services/register')
      .send({ servicePath: '/abs/my-service' });
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('Unknown error');
  });

  it('500 on outer catch when provisioning throws a non-Error (Unknown error)', async () => {
    mockedFs.readFile.mockResolvedValue(JSON.stringify(TEMPLATE));
    jest
      .spyOn(ResourceProvisioner.getInstance(), 'provisionResources')
      .mockRejectedValue('boom' as any);
    const res = await request(appWith())
      .post('/api/services/register')
      .send({ servicePath: '/abs/my-service' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Unknown error');
  });
});

describe('GET /api/services', () => {
  it('lists services with resource breakdown', async () => {
    jest.spyOn(CacheManager.prototype, 'listServices').mockResolvedValue([{ ...META }]);
    jest.spyOn(CacheManager.prototype, 'getTemplate').mockResolvedValue(TEMPLATE);
    const res = await request(appWith()).get('/api/services');
    expect(res.status).toBe(200);
    expect(res.body[0].resourcesCount).toBe(6);
    expect(res.body[0].resourceBreakdown).toEqual({
      lambdas: 1, tables: 1, queues: 1, topics: 1, buckets: 1,
    });
  });

  it('handles a service with no cached template (empty resources)', async () => {
    jest.spyOn(CacheManager.prototype, 'listServices').mockResolvedValue([{ ...META }]);
    jest.spyOn(CacheManager.prototype, 'getTemplate').mockResolvedValue(null);
    const res = await request(appWith()).get('/api/services');
    expect(res.status).toBe(200);
    expect(res.body[0].resourcesCount).toBe(0);
  });

  it('500 when listing fails', async () => {
    jest.spyOn(CacheManager.prototype, 'listServices').mockRejectedValue(new Error('disk'));
    const res = await request(appWith()).get('/api/services');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to list services');
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
    expect(res.body.resourcesCount).toBe(6);
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

  it('200 deletes (template present -> parsed resources cleaned up)', async () => {
    jest.spyOn(CacheManager.prototype, 'getTemplate').mockResolvedValue(TEMPLATE);
    const res = await request(appWith()).delete('/api/services/my-service');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('200 deletes when no cached template (empty resources)', async () => {
    jest.spyOn(CacheManager.prototype, 'getTemplate').mockResolvedValue(null);
    const res = await request(appWith()).delete('/api/services/my-service');
    expect(res.status).toBe(200);
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

describe('GET /api/services/:name/logs', () => {
  it('400 on invalid service name', async () => {
    const res = await request(appWith()).get('/api/services/a..b/logs');
    expect(res.status).toBe(400);
  });

  it('200 returns logs', async () => {
    jest.spyOn(processManager, 'getLogs').mockReturnValue({ logs: ['a'], status: 'running' as any });
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
