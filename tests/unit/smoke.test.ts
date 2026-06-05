import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Repo root, derived relative to this file so it works on any checkout path
// (CI checks out under a different absolute path than the dev container).
const ROOT = path.resolve(__dirname, '../..');

describe('Quick Smoke Tests', () => {
  describe('CLI Availability', () => {
    it('should have lss command available', async () => {
      const { stdout } = await execFileAsync('node', [path.join(ROOT, 'bin/cli.js'), 'help']);
      expect(stdout).toContain('start');
    });
  });

  describe('Project Build', () => {
    it('should have built orchestrator', () => {
      expect(fs.existsSync(path.join(ROOT, 'dist/server'))).toBe(true);
    });

    it('should have built plugin', () => {
      expect(fs.existsSync(path.join(ROOT, 'packages/serverless-plugin/dist'))).toBe(true);
    });

    it('should have CLI script', () => {
      expect(fs.existsSync(path.join(ROOT, 'bin/cli.js'))).toBe(true);
    });
  });

  describe('Configuration Files', () => {
    it('should have package.json with correct bin', () => {
      const packageJson = require(path.join(ROOT, 'package.json'));
      expect(packageJson.bin).toHaveProperty('lss');
      expect(packageJson.bin.lss).toBe('./bin/cli.js');
    });

    it('should have jest config', () => {
      expect(fs.existsSync(path.join(ROOT, 'jest.config.js'))).toBe(true);
    });
  });
});
