import * as path from 'path';
import { runServerlessPackage, ServerlessPackageError } from '../../src/server/services/serverless-packager';

describe('runServerlessPackage', () => {
  const cwd = path.resolve(__dirname);

  it('resolves when the command exits 0', async () => {
    const result = await runServerlessPackage({
      command: 'node -e "process.stdout.write(\'ok\')"',
      cwd,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok');
  });

  it('rejects with ServerlessPackageError when the command exits non-zero', async () => {
    expect.assertions(3);
    try {
      await runServerlessPackage({
        command: 'node -e "console.error(\'boom\'); process.exit(2)"',
        cwd,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(ServerlessPackageError);
      const packErr = err as ServerlessPackageError;
      expect(packErr.result.exitCode).toBe(2);
      expect(packErr.result.stderr).toContain('boom');
    }
  });

  it('rejects when the command binary does not exist', async () => {
    expect.assertions(2);
    try {
      await runServerlessPackage({
        command: '/nonexistent/binary/that/cannot/be/found',
        cwd,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(ServerlessPackageError);
      expect((err as ServerlessPackageError).message).toMatch(/Failed to start/);
    }
  });

  it('rejects when the command exceeds the timeout', async () => {
    expect.assertions(2);
    try {
      await runServerlessPackage({
        command: 'node -e "setTimeout(()=>{}, 10000)"',
        cwd,
        timeoutMs: 200,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(ServerlessPackageError);
      expect((err as ServerlessPackageError).message).toMatch(/timed out/);
    }
  }, 10000);

  it('parses quoted args correctly', async () => {
    const result = await runServerlessPackage({
      command: 'node -e "process.stdout.write(process.argv.slice(1).join(\'|\'))" foo "bar baz" qux',
      cwd,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('foo|bar baz|qux');
  });
});
