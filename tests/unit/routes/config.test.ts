// Unit test for the /api/config route. Mounts the router on a throwaway Express
// app and drives it with supertest; the ConfigManager singleton is stubbed.
import express from 'express';
import request from 'supertest';
import { configRouter } from '../../../src/server/routes/config';
import { ConfigManager } from '../../../src/server/services/config-manager';

function appWith() {
  const app = express();
  app.use(express.json());
  app.use('/api/config', configRouter);
  return app;
}

describe('GET /api/config', () => {
  afterEach(() => jest.restoreAllMocks());

  function stub(authToken: string | undefined) {
    const cm = ConfigManager.getInstance();
    jest.spyOn(cm, 'getServerPort').mockReturnValue(3100);
    jest.spyOn(cm, 'getMode').mockReturnValue('managed');
    jest.spyOn(cm, 'getLocalStackEndpoint').mockReturnValue('http://localhost:4566');
    jest.spyOn(cm, 'getLocalStackPort').mockReturnValue(4566);
    jest.spyOn(cm, 'getLocalStackEdition').mockReturnValue('community');
    jest.spyOn(cm, 'getLocalStackVersion').mockReturnValue('latest');
    jest.spyOn(cm, 'getLocalStackImage').mockReturnValue('localstack/localstack:latest');
    jest.spyOn(cm, 'getLocalStackAuthToken').mockReturnValue(authToken);
    jest.spyOn(cm, 'isEnableDynamoProxy').mockReturnValue(false);
    jest.spyOn(cm, 'getDynamoProxyPort').mockReturnValue(8000);
    jest.spyOn(cm, 'getRegion').mockReturnValue('us-east-1');
    jest.spyOn(cm, 'getServices').mockReturnValue(['sqs', 'dynamodb']);
    jest.spyOn(cm, 'isPersistence').mockReturnValue(true);
    jest.spyOn(cm, 'isDebug').mockReturnValue(false);
    jest.spyOn(cm, 'getSeedsDir').mockReturnValue('/abs/seeds');
    jest.spyOn(cm, 'isAutoPackage').mockReturnValue(false);
    jest.spyOn(cm, 'getPackageCommand').mockReturnValue('npx serverless package');
    jest.spyOn(cm, 'getPackageTimeoutMs').mockReturnValue(300000);
    jest.spyOn(cm, 'getConfigPath').mockReturnValue('/abs/lss.config.json');
  }

  it('returns the public config snapshot and never leaks the auth token', async () => {
    stub('secret-token');
    const res = await request(appWith()).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      serverPort: 3100,
      localstack: { mode: 'managed', port: 4566, hasAuthToken: true },
      dynamoProxy: { enabled: false, port: 8000 },
      region: 'us-east-1',
      services: ['sqs', 'dynamodb'],
      configPath: '/abs/lss.config.json',
    });
    // The token value itself must never appear in the payload.
    expect(JSON.stringify(res.body)).not.toContain('secret-token');
  });

  it('reports hasAuthToken=false when no token is configured', async () => {
    stub(undefined);
    const res = await request(appWith()).get('/api/config');
    expect(res.body.localstack.hasAuthToken).toBe(false);
  });
});
