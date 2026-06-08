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

  it('strips inner double quotes in --flag="value" tokens (regression)', async () => {
    // `--` ends node's own option parsing so the flag reaches the script as argv.
    const result = await runServerlessPackage({
      command:
        'node -e "process.stdout.write(process.argv.slice(1).join(\'|\'))" -- --param="custom-stage=offline"',
      cwd,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('--param=custom-stage=offline');
  });

  it('strips inner single quotes in --flag=\'value\' tokens', async () => {
    const result = await runServerlessPackage({
      command:
        "node -e \"process.stdout.write(process.argv.slice(1).join('|'))\" -- --param='custom-stage=offline'",
      cwd,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('--param=custom-stage=offline');
  });

  it('preserves spaces inside a quoted segment of a --flag="a b c" token', async () => {
    const result = await runServerlessPackage({
      command:
        'node -e "process.stdout.write(process.argv.slice(1).join(\'|\'))" -- --foo="a b c"',
      cwd,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('--foo=a b c');
  });

  it('appends extra args after the parsed command args', async () => {
    const result = await runServerlessPackage({
      command: 'node -e "process.stdout.write(process.argv.slice(1).join(\'|\'))" first',
      args: ['--param=custom-stage=offline', 'second'],
      cwd,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('first|--param=custom-stage=offline|second');
  });

  it('treats an empty extra-args array as a no-op', async () => {
    const result = await runServerlessPackage({
      command: 'node -e "process.stdout.write(process.argv.slice(1).join(\'|\'))" only',
      args: [],
      cwd,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('only');
  });

  it('rejects when the command is empty (regex match returns null)', async () => {
    await expect(
      runServerlessPackage({ command: '', cwd }),
    ).rejects.toThrow('Empty package command');
  });

  it('rejects when the command is whitespace only', async () => {
    await expect(
      runServerlessPackage({ command: '   ', cwd }),
    ).rejects.toThrow('Empty package command');
  });

  it('passes env vars through to the spawned process', async () => {
    const result = await runServerlessPackage({
      command: 'node -e "process.stdout.write(process.env.LSS_TEST_VAR || \'missing\')"',
      cwd,
      env: { LSS_TEST_VAR: 'passed-through' },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('passed-through');
  });

  it('escalates to SIGKILL when the process ignores SIGTERM on timeout', async () => {
    expect.assertions(2);
    try {
      await runServerlessPackage({
        // Trap SIGTERM so the initial kill is ignored, forcing the
        // 2s SIGKILL fallback timer to fire.
        command:
          'node -e "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000)"',
        cwd,
        timeoutMs: 200,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(ServerlessPackageError);
      expect((err as ServerlessPackageError).message).toMatch(/timed out/);
    }
  }, 15000);
});
