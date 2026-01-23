import { TestUtils } from '../helpers/test-utils';

describe('Quick Smoke Tests', () => {
  describe('CLI Availability', () => {
    it('should have lss command available', async () => {
      const result = await TestUtils.execCli('help');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('start');
    });
  });

  describe('Project Build', () => {
    it('should have built orchestrator', async () => {
      const fs = require('fs');
      const orchestratorDist = '/workspaces/local-serverless-stack/dist/server';
      expect(fs.existsSync(orchestratorDist)).toBe(true);
    });

    it('should have built plugin', async () => {
      const fs = require('fs');
      const pluginDist = '/workspaces/local-serverless-stack/packages/serverless-plugin/dist';
      expect(fs.existsSync(pluginDist)).toBe(true);
    });

    it('should have CLI script', async () => {
      const fs = require('fs');
      const cliPath = '/workspaces/local-serverless-stack/bin/cli.js';
      expect(fs.existsSync(cliPath)).toBe(true);
    });
  });

  describe('Configuration Files', () => {
    it('should have package.json with correct bin', async () => {
      const packageJson = require('../../package.json');
      expect(packageJson.bin).toHaveProperty('lss');
      expect(packageJson.bin.lss).toBe('./bin/cli.js');
    });

    it('should have jest config', async () => {
      const fs = require('fs');
      const jestConfig = '/workspaces/local-serverless-stack/jest.config.js';
      expect(fs.existsSync(jestConfig)).toBe(true);
    });
  });
});
