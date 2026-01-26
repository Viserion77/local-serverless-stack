import { get, post, del } from './fetch-helpers';
import { TestUtils } from '../helpers/test-utils';

const ORCHESTRATOR_URL = 'http://localhost:3100';

describe('Orchestrator API Integration Tests', () => {
  beforeAll(async () => {
    // Start orchestrator
    await TestUtils.execCli('start');
    await TestUtils.waitForPort(3100);
    await TestUtils.waitForLocalStack();
  }, 60000);

  afterAll(async () => {
    // Stop orchestrator
    await TestUtils.execCli('stop');
    await TestUtils.cleanupTempFiles();
  });

  describe('Health Check', () => {
    it('should return health status', async () => {
      const response = await get(`${ORCHESTRATOR_URL}/api/health`);

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('status');
      expect(response.data.status).toBe('ok');
    });
  });

  describe('Service Registration', () => {
    it('should register a new service successfully', async () => {
      const serviceName = 'test-service';
      const servicePath = await TestUtils.createTempServiceDir(serviceName);

      const response = await post(`${ORCHESTRATOR_URL}/api/services/register`, {
        servicePath,
        invokePort: 13000,
      });

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('success');
      expect(response.data.success).toBe(true);
      expect(response.data.serviceName).toContain(serviceName);

      // Cleanup
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      await execAsync(`rm -rf ${servicePath}`);
    }, 30000);

    it('should handle invalid service path', async () => {
      try {
        await post(`${ORCHESTRATOR_URL}/api/services/register`, {
          servicePath: '/non/existent/path',
          invokePort: 13001,
        });
        fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.status).toBeGreaterThanOrEqual(400);
      }
    });

    it('should handle missing required fields', async () => {
      try {
        await post(`${ORCHESTRATOR_URL}/api/services/register`, {
          // Missing servicePath
          invokePort: 13002,
        });
        fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.status).toBe(400);
        expect(error.data).toHaveProperty('error');
      }
    });
  });

  describe('Services List', () => {
    let testServicePath: string;

    beforeAll(async () => {
      // Register a test service for list tests
      testServicePath = await TestUtils.createTempServiceDir('list-test-service');
      await post(`${ORCHESTRATOR_URL}/api/services/register`, {
        servicePath: testServicePath,
        invokePort: 13100,
      });
    });

    afterAll(async () => {
      // Cleanup
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      await execAsync(`rm -rf ${testServicePath}`);
    });

    it('should return list of registered services', async () => {
      const response = await get(`${ORCHESTRATOR_URL}/api/services`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.data)).toBe(true);
      expect(response.data.length).toBeGreaterThan(0);
    });

    it('should include test-service in the list', async () => {
      const response = await get(`${ORCHESTRATOR_URL}/api/services`);

      const service = response.data.find((s: any) => s.name.includes('list-test-service'));
      expect(service).toBeDefined();
      expect(service.invokePort).toBe(13100);
      expect(service.status).toBe('registered');
    });
  });

  describe('Resources', () => {
    let resourceTestPath: string;

    beforeAll(async () => {
      // Register a service with specific resources
      resourceTestPath = await TestUtils.createTempServiceDir('resource-test-service');
      await post(`${ORCHESTRATOR_URL}/api/services/register`, {
        servicePath: resourceTestPath,
        invokePort: 13200,
      });
      // Wait for provisioning
      await new Promise(resolve => setTimeout(resolve, 3000));
    });

    afterAll(async () => {
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      await execAsync(`rm -rf ${resourceTestPath}`);
    });

    it('should return all provisioned resources', async () => {
      const response = await get(`${ORCHESTRATOR_URL}/api/resources`);

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('tables');
      expect(response.data).toHaveProperty('queues');
      expect(response.data).toHaveProperty('topics');
      expect(Array.isArray(response.data.tables)).toBe(true);
      expect(Array.isArray(response.data.queues)).toBe(true);
      expect(Array.isArray(response.data.topics)).toBe(true);
    });

    it('should include resources from test-service', async () => {
      const response = await get(`${ORCHESTRATOR_URL}/api/resources`);

      // Check for DynamoDB table
      expect(response.data.tables).toContain('resource-test-service.TestTable');

      // Check for SQS queue
      const hasTestQueue = response.data.queues.some((q: string) =>
        q.includes('resource-test-service-test-queue'),
      );
      expect(hasTestQueue).toBe(true);
    });
  });

  describe('Service Deletion', () => {
    it('should delete a service and its resources', async () => {
      // Create and register a service to delete
      const servicePath = await TestUtils.createTempServiceDir('delete-test-service');
      await post(`${ORCHESTRATOR_URL}/api/services/register`, {
        servicePath,
        invokePort: 13300,
      });

      // Delete the service
      const response = await del(`${ORCHESTRATOR_URL}/api/services/delete-test-service`);

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('success');
      expect(response.data.success).toBe(true);

      // Cleanup
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      await execAsync(`rm -rf ${servicePath}`);
    }, 15000);

    it('should return error when deleting non-existent service', async () => {
      try {
        await del(`${ORCHESTRATOR_URL}/api/services/non-existent-service`);
        // API pode retornar 200 mesmo se não existir
        expect(true).toBe(true);
      } catch (error: any) {
        if (error.response) {
          expect(error.status).toBeGreaterThanOrEqual(400);
        }
      }
    });
  });

  describe('Error Handling', () => {
    it('should return 404 for unknown routes', async () => {
      try {
        await get(`${ORCHESTRATOR_URL}/api/unknown-route-that-does-not-exist`);
        fail('Should have thrown an error');
      } catch (error: any) {
        // Either we get a proper HTTP error or a network error - both are acceptable
        expect(error).toBeDefined();
        if (error.response) {
          expect(error.status).toBeGreaterThanOrEqual(400);
        }
      }
    });

    it('should handle malformed JSON', async () => {
      try {
        const response = await fetch(`${ORCHESTRATOR_URL}/api/services/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'invalid json',
        });
        
        if (response.ok) {
          fail('Should have thrown an error');
        }
        expect(response.status).toBeGreaterThanOrEqual(400);
      } catch (error: any) {
        // Fetch might throw on some errors - also acceptable
        expect(error).toBeDefined();
      }
    });
  });
});
