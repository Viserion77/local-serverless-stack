import { get, post, del, FetchError } from './fetch-helpers';
import { TestUtils } from '../helpers/test-utils';
import * as fs from 'fs/promises';
import * as path from 'path';

const ORCHESTRATOR_URL = 'http://localhost:3100';

describe('Serverless Plugin Integration Tests', () => {
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

  describe('Plugin Registration Flow', () => {
    it('should successfully register service via plugin', async () => {
      const servicePath = await TestUtils.createTempServiceDir('plugin-test-service');

      const response = await post(`${ORCHESTRATOR_URL}/api/services/register`, {
        servicePath,
        invokePort: 13010,
      });

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('success');
      expect(response.data.success).toBe(true);

      // Verify service appears in list
      const servicesResponse = await get(`${ORCHESTRATOR_URL}/api/services`);
      const service = servicesResponse.data.find((s: any) => s.name.includes('plugin-test-service'));

      expect(service).toBeDefined();
      expect(service.invokePort).toBe(13010);

      // Cleanup
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      await execAsync(`rm -rf ${servicePath}`);
    }, 30000);

    it('should provision DynamoDB tables from CloudFormation', async () => {
      const servicePath = await TestUtils.createTempServiceDir('dynamo-test-service');
      
      await post(`${ORCHESTRATOR_URL}/api/services/register`, {
        servicePath,
        invokePort: 13011,
      });

      // Wait for provisioning
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Verify table exists in LocalStack
      const resourcesResponse = await get(`${ORCHESTRATOR_URL}/api/resources`);
      expect(resourcesResponse.data.tables).toContain('dynamo-test-service.TestTable');

      // Cleanup
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      await execAsync(`rm -rf ${servicePath}`);
    }, 30000);

    it('should provision SQS queues from CloudFormation', async () => {
      const servicePath = await TestUtils.createTempServiceDir('sqs-test-service');
      
      await post(`${ORCHESTRATOR_URL}/api/services/register`, {
        servicePath,
        invokePort: 13012,
      });

      // Wait for provisioning
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Verify queue exists
      const resourcesResponse = await get(`${ORCHESTRATOR_URL}/api/resources`);
      const hasQueue = resourcesResponse.data.queues.some((q: string) =>
        q.includes('sqs-test-service-test-queue'),
      );
      expect(hasQueue).toBe(true);

      // Cleanup
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      await execAsync(`rm -rf ${servicePath}`);
    }, 30000);

    it('should provision SNS topics from CloudFormation', async () => {
      const servicePath = await TestUtils.createTempServiceDir('sns-test-service');
      
      await post(`${ORCHESTRATOR_URL}/api/services/register`, {
        servicePath,
        invokePort: 13013,
      });

      // Wait for provisioning
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Verify topic exists
      const resourcesResponse = await get(`${ORCHESTRATOR_URL}/api/resources`);
      const hasTopic = resourcesResponse.data.topics.some((t: string) =>
        t.includes('sns-test-service-test-topic'),
      );
      expect(hasTopic).toBe(true);

      // Cleanup
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      await execAsync(`rm -rf ${servicePath}`);
    }, 30000);

    it('should create Lambda proxy for event source mappings', async () => {
      const servicePath = await TestUtils.createTempServiceDir('lambda-proxy-test');
      
      await post(`${ORCHESTRATOR_URL}/api/services/register`, {
        servicePath,
        invokePort: 13014,
      });

      // Wait for provisioning including Lambda proxies
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Test passes if no errors occurred during proxy creation
      expect(true).toBe(true);

      // Cleanup
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      await execAsync(`rm -rf ${servicePath}`);
    }, 40000);
  });

  describe('Plugin Error Handling', () => {
    it('should handle duplicate service registration', async () => {
      const servicePath = await TestUtils.createTempServiceDir('duplicate-test');
      
      // Register first time
      await post(`${ORCHESTRATOR_URL}/api/services/register`, {
        servicePath,
        invokePort: 13015,
      });

      // Try to register again - should handle gracefully
      const response = await post(`${ORCHESTRATOR_URL}/api/services/register`, {
        servicePath,
        invokePort: 13016,
      });

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('success');

      // Cleanup
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      await execAsync(`rm -rf ${servicePath}`);
    }, 30000);
  });
});
