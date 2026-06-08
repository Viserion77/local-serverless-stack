import { spawn } from 'child_process';

export interface PackageOptions {
  command: string;
  cwd: string;
  // Extra args appended AFTER the args parsed from `command`. Passed straight to
  // spawn(), so they bypass the string parser entirely — values with spaces or
  // `=` (e.g. `--param=custom-stage=offline`) are delivered intact, no quoting.
  args?: string[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface PackageResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class ServerlessPackageError extends Error {
  constructor(
    message: string,
    public readonly result: PackageResult,
  ) {
    super(message);
    this.name = 'ServerlessPackageError';
  }
}

function parseCommand(raw: string): { cmd: string; args: string[] } {
  const tokens = raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  // Strip quotes per quoted segment within each token, not just one leading +
  // one trailing quote off the whole token. This keeps `--param="x=y"` intact as
  // `--param=x=y` (the old logic produced the malformed `--param=x=y"`).
  const unquoted = tokens.map(t => t.replace(/"([^"]*)"|'([^']*)'/g, '$1$2'));
  if (unquoted.length === 0) {
    throw new Error('Empty package command');
  }
  return { cmd: unquoted[0], args: unquoted.slice(1) };
}

export async function runServerlessPackage(options: PackageOptions): Promise<PackageResult> {
  const { cmd, args } = parseCommand(options.command);
  const allArgs = [...args, ...(options.args ?? [])];
  const timeoutMs = options.timeoutMs ?? 300000;

  return new Promise<PackageResult>((resolve, reject) => {
    const proc = spawn(cmd, allArgs, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 2000).unref();
    }, timeoutMs);
    timer.unref();

    proc.stdout?.on('data', chunk => { stdout += chunk.toString(); });
    proc.stderr?.on('data', chunk => { stderr += chunk.toString(); });

    proc.on('error', err => {
      clearTimeout(timer);
      reject(new ServerlessPackageError(
        `Failed to start package command "${options.command}": ${err.message}`,
        { exitCode: -1, stdout, stderr },
      ));
    });

    proc.on('close', code => {
      clearTimeout(timer);
      const result: PackageResult = { exitCode: code ?? -1, stdout, stderr };
      if (timedOut) {
        reject(new ServerlessPackageError(
          `Package command "${options.command}" timed out after ${timeoutMs}ms`,
          result,
        ));
        return;
      }
      if (code === 0) {
        resolve(result);
        return;
      }
      reject(new ServerlessPackageError(
        `Package command "${options.command}" exited with code ${code}`,
        result,
      ));
    });
  });
}
