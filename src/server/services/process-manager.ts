import { spawn, ChildProcess } from 'child_process';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export type ProcessStatus = 'running' | 'stopped' | 'failed';

interface RunOptions {
  cwd: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

interface ManagedProcess {
  proc: ChildProcess;
  logs: string[];
  status: ProcessStatus;
  exitCode?: number | null;
  startedAt: number;
}

const LOG_LIMIT = 500;

export class ProcessManager {
  private processes = new Map<string, ManagedProcess>();

  private async killProcessTree(pid: number | undefined): Promise<void> {
    if (!pid) return;

    try {
      // Try to kill the process tree using pkill (works on Unix/Linux)
      await execAsync(`pkill -P ${pid}`);
    } catch {
      // Ignore errors, pkill might not be available
    }

    try {
      // Kill the main process
      process.kill(pid, 'SIGTERM');

      // Wait a bit and then SIGKILL if still alive
      await new Promise(r => setTimeout(r, 500));
      process.kill(pid, 'SIGKILL');
    } catch {
      // Process might already be dead
    }
  }

  start(serviceName: string, options: RunOptions) {
    const existing = this.processes.get(serviceName);
    if (existing && existing.status === 'running') {
      throw new Error(`Service ${serviceName} is already running`);
    }

    const command = options.command || 'npm';
    const args = options.args && options.args.length > 0 ? options.args : ['run', 'start'];

    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const managed: ManagedProcess = {
      proc,
      logs: [],
      status: 'running',
      startedAt: Date.now(),
    };

    const appendLog = (prefix: string, chunk: Buffer) => {
      const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        managed.logs.push(`${prefix} ${line}`);
      }
      if (managed.logs.length > LOG_LIMIT) {
        managed.logs.splice(0, managed.logs.length - LOG_LIMIT);
      }
    };

    proc.stdout?.on('data', data => appendLog('stdout:', data));
    proc.stderr?.on('data', data => appendLog('stderr:', data));

    proc.on('close', code => {
      managed.status = code === 0 ? 'stopped' : 'failed';
      managed.exitCode = code;
      this.processes.set(serviceName, managed);
    });

    proc.on('error', err => {
      appendLog('error:', Buffer.from(String(err)));
      managed.status = 'failed';
      this.processes.set(serviceName, managed);
    });

    this.processes.set(serviceName, managed);

    return { pid: proc.pid, status: managed.status };
  }

  stop(serviceName: string) {
    const managed = this.processes.get(serviceName);
    if (!managed) return { stopped: false };

    // Kill the process tree aggressively
    this.killProcessTree(managed.proc.pid);
    managed.status = 'stopped';
    this.processes.set(serviceName, managed);
    return { stopped: true };
  }

  getStatus(serviceName: string) {
    const managed = this.processes.get(serviceName);
    if (!managed) return null;

    return {
      pid: managed.proc.pid,
      status: managed.status,
      exitCode: managed.exitCode,
      startedAt: managed.startedAt,
    };
  }

  getLogs(serviceName: string) {
    const managed = this.processes.get(serviceName);
    if (!managed) return { logs: [], status: 'stopped' as ProcessStatus };

    return {
      logs: managed.logs,
      status: managed.status,
      pid: managed.proc.pid,
      exitCode: managed.exitCode,
      startedAt: managed.startedAt,
    };
  }

  stopAll() {
    for (const name of this.processes.keys()) {
      this.stop(name);
    }
  }

  async cleanup() {
    // Give processes time to exit gracefully, then force kill any remaining
    await new Promise(r => setTimeout(r, 1000));
    for (const managed of this.processes.values()) {
      if (managed.status === 'running') {
        await this.killProcessTree(managed.proc.pid);
      }
    }
  }
}
