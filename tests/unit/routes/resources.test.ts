// Unit test for the /api/resources route. Mounts the router on a throwaway
// Express app and drives it with supertest. The ResourceProvisioner singleton
// is spied; CacheManager / CloudFormationParser are module-level instances, so
// we spy their prototypes (which the cached instances delegate to).
import express from 'express';
import request from 'supertest';
import { resourcesRouter } from '../../../src/server/routes/resources';
import { ResourceProvisioner } from '../../../src/server/services/resource-provisioner';
import { CacheManager } from '../../../src/server/services/cache-manager';
import { CloudFormationParser } from '../../../src/server/services/cloudformation-parser';
import { ConfigManager } from '../../../src/server/services/config-manager';

function appWith() {
  const app = express();
  app.use(express.json());
  app.use('/api/resources', resourcesRouter);
  return app;
}

describe('resources router', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('GET /', () => {
    it('returns aggregated resources and passes through the region query', async () => {
      const provisioner = ResourceProvisioner.getInstance();
      const payload = { tables: ['t1'], queues: [], topics: [], buckets: [] };
      const spy = jest.spyOn(provisioner, 'listAllResources').mockResolvedValue(payload as any);

      const res = await request(appWith()).get('/api/resources?region=eu-west-1');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(payload);
      expect(spy).toHaveBeenCalledWith('eu-west-1');
    });

    it('treats a missing/empty region query as undefined', async () => {
      const provisioner = ResourceProvisioner.getInstance();
      const spy = jest
        .spyOn(provisioner, 'listAllResources')
        .mockResolvedValue({ tables: [], queues: [], topics: [], buckets: [] } as any);

      // Empty region string -> falsy -> undefined branch.
      const res = await request(appWith()).get('/api/resources?region=');

      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledWith(undefined);
    });

    it('returns 500 when the provisioner throws', async () => {
      const provisioner = ResourceProvisioner.getInstance();
      jest.spyOn(provisioner, 'listAllResources').mockRejectedValue(new Error('boom'));

      const res = await request(appWith()).get('/api/resources');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'boom' });
    });
  });

  describe('GET /owners', () => {
    it('maps resource names to declaring services, filtered by region', async () => {
      jest.spyOn(CacheManager.prototype, 'init').mockResolvedValue(undefined);
      jest.spyOn(CacheManager.prototype, 'listServices').mockResolvedValue([
        { name: 'svc-a', region: 'us-east-1' } as any,
        { name: 'svc-b', region: undefined } as any, // falls back to defaultRegion
        { name: 'svc-c', region: 'eu-west-1' } as any, // filtered out
      ]);
      jest.spyOn(ConfigManager.getInstance(), 'getRegion').mockReturnValue('us-east-1');

      jest
        .spyOn(CacheManager.prototype, 'getTemplate')
        .mockImplementation(async (name: string) => {
          if (name === 'svc-a') return { svc: 'a' };
          if (name === 'svc-b') return null; // continue branch
          return { svc: 'other' };
        });

      jest.spyOn(CloudFormationParser.prototype, 'parse').mockImplementation((tpl: any) => {
        if (tpl.svc === 'a') {
          return [
            { type: 'dynamodb', name: 'Table1' },
            { type: 'sqs', name: 'Queue1' },
            { type: 'sns', name: 'Topic1' },
            { type: 's3', name: 'Bucket1' },
            { type: 'lambda', name: 'FnIgnored' }, // unmatched type
          ] as any;
        }
        return [] as any;
      });

      const res = await request(appWith()).get('/api/resources/owners?region=us-east-1');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        tables: [{ name: 'Table1', service: 'svc-a' }],
        queues: [{ name: 'Queue1', service: 'svc-a' }],
        topics: [{ name: 'Topic1', service: 'svc-a' }],
        buckets: [{ name: 'Bucket1', service: 'svc-a' }],
      });
    });

    it('returns all services when no region query is provided', async () => {
      jest.spyOn(CacheManager.prototype, 'init').mockResolvedValue(undefined);
      jest
        .spyOn(CacheManager.prototype, 'listServices')
        .mockResolvedValue([{ name: 'svc-a', region: 'eu-west-1' } as any]);
      jest.spyOn(ConfigManager.getInstance(), 'getRegion').mockReturnValue('us-east-1');
      jest.spyOn(CacheManager.prototype, 'getTemplate').mockResolvedValue({ any: true });
      jest
        .spyOn(CloudFormationParser.prototype, 'parse')
        .mockReturnValue([{ type: 'dynamodb', name: 'T' }] as any);

      const res = await request(appWith()).get('/api/resources/owners');

      expect(res.status).toBe(200);
      expect(res.body.tables).toEqual([{ name: 'T', service: 'svc-a' }]);
    });

    it('returns 500 when service listing fails', async () => {
      jest.spyOn(CacheManager.prototype, 'init').mockResolvedValue(undefined);
      jest.spyOn(CacheManager.prototype, 'listServices').mockRejectedValue(new Error('cache down'));

      const res = await request(appWith()).get('/api/resources/owners');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'cache down' });
    });
  });
});
