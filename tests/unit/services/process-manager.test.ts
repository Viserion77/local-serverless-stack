// Unit tests for ProcessManager. child_process is fully mocked: `spawn` returns
// a fake ChildProcess (an EventEmitter with stdout/stderr EventEmitters, a pid
// and a kill stub) so we can drive the data/close/error handlers by emitting
// events ourselves, and `exec` invokes its callback synchronously so the
// promisified killProcessTree path is deterministic. process.kill is stubbed so
// no real signals are ever sent.
import { EventEmitter } from 'events';

// --- child_process mock -----------------------------------------------------
// Controllable per-call behaviour for the promisified exec (pkill) call.
let execImpl: (cmd: string, cb: (err: Error | null, out: { stdout: string; stderr: string }) => void) => void;

jest.mock('child_process', () => ({
  spawn: jest.fn(),
  exec: jest.fn((cmd: string, cb: (err: Error | null, out: { stdout: string; stderr: string }) => void) => {
    execImpl(cmd, cb);
  }),
}));

import { spawn } from 'child_process';
import { ProcessManager } from '../../../src/server/services/process-manager';

const spawnMock = spawn as unknown as jest.Mock;

// A minimal fake ChildProcess: EventEmitter (close/error) plus stdout/stderr
// EventEmitters (data) and a kill stub.
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid: number | undefined;
  kill = jest.fn();
  constructor(pid: number | undefined) {
    super();
    this.pid = pid;
  }
}

let pm: ProcessManager;
let child: FakeChild;
let killSpy: jest.SpyInstance;

beforeEach(() => {
  spawnMock.mockReset();
  // Default exec behaviour: succeed (pkill found children).
  execImpl = (_cmd, cb) => cb(null, { stdout: '', stderr: '' });
  child = new FakeChild(1234);
  spawnMock.mockReturnValue(child);
  // Never deliver a real signal to a real pid.
  killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
  pm = new ProcessManager();
});

afterEach(() => {
  jest.useRealTimers();
  killSpy.mockRestore();
});

describe('start', () => {
  it('spawns with defaults (npm run start) when no command/args are given', () => {
    const res = pm.start('svc', { cwd: '/tmp/app' });
    expect(res).toEqual({ pid: 1234, status: 'running' });
    expect(spawnMock).toHaveBeenCalledWith(
      'npm',
      ['run', 'start'],
      expect.objectContaining({ cwd: '/tmp/app', stdio: ['ignore', 'pipe', 'pipe'] }),
    );
    // env is merged from process.env + options.env
    const opts = spawnMock.mock.calls[0][2];
    expect(opts.env).toEqual(expect.objectContaining(process.env));
  });

  it('honours an explicit command, args and env', () => {
    pm.start('svc', { cwd: '/tmp/app', command: 'node', args: ['index.js'], env: { FOO: 'bar' } });
    expect(spawnMock).toHaveBeenCalledWith(
      'node',
      ['index.js'],
      expect.objectContaining({ env: expect.objectContaining({ FOO: 'bar' }) }),
    );
  });

  it('falls back to default args when args is an empty array', () => {
    pm.start('svc', { cwd: '/tmp/app', command: 'node', args: [] });
    expect(spawnMock).toHaveBeenCalledWith('node', ['run', 'start'], expect.anything());
  });

  it('throws when the service is already running', () => {
    pm.start('svc', { cwd: '/tmp/app' });
    expect(() => pm.start('svc', { cwd: '/tmp/app' })).toThrow('Service svc is already running');
  });

  it('allows restarting a service that has stopped', () => {
    pm.start('svc', { cwd: '/tmp/app' });
    child.emit('close', 0); // status -> stopped
    expect(pm.getStatus('svc')!.status).toBe('stopped');
    // a fresh child for the restart
    const child2 = new FakeChild(5678);
    spawnMock.mockReturnValue(child2);
    expect(() => pm.start('svc', { cwd: '/tmp/app' })).not.toThrow();
    expect(pm.getStatus('svc')!.pid).toBe(5678);
  });

  it('captures stdout and stderr lines (filtering blanks)', () => {
    pm.start('svc', { cwd: '/tmp/app' });
    child.stdout.emit('data', Buffer.from('hello\n\nworld\r\n'));
    child.stderr.emit('data', Buffer.from('oops\n'));
    expect(pm.getLogs('svc').logs).toEqual(['stdout: hello', 'stdout: world', 'stderr: oops']);
  });

  it('caps the log buffer at 500 lines', () => {
    pm.start('svc', { cwd: '/tmp/app' });
    const big = Array.from({ length: 600 }, (_, i) => `line${i}`).join('\n');
    child.stdout.emit('data', Buffer.from(big));
    const logs = pm.getLogs('svc').logs;
    expect(logs).toHaveLength(500);
    // oldest 100 were spliced off
    expect(logs[0]).toBe('stdout: line100');
    expect(logs[499]).toBe('stdout: line599');
  });

  it('marks the process stopped on a clean close (code 0)', () => {
    pm.start('svc', { cwd: '/tmp/app' });
    child.emit('close', 0);
    const status = pm.getStatus('svc')!;
    expect(status.status).toBe('stopped');
    expect(status.exitCode).toBe(0);
  });

  it('marks the process failed on a non-zero close', () => {
    pm.start('svc', { cwd: '/tmp/app' });
    child.emit('close', 1);
    const status = pm.getStatus('svc')!;
    expect(status.status).toBe('failed');
    expect(status.exitCode).toBe(1);
  });

  it('records the error and marks failed on an error event', () => {
    pm.start('svc', { cwd: '/tmp/app' });
    child.emit('error', new Error('spawn ENOENT'));
    const { logs, status } = pm.getLogs('svc');
    expect(status).toBe('failed');
    expect(logs.some(l => l.includes('error:') && l.includes('spawn ENOENT'))).toBe(true);
  });
});

describe('stop', () => {
  it('returns {stopped:false} for an unknown service', () => {
    expect(pm.stop('nope')).toEqual({ stopped: false });
  });

  it('kills the process tree and marks it stopped', async () => {
    jest.useFakeTimers();
    pm.start('svc', { cwd: '/tmp/app' });
    const res = pm.stop('svc');
    expect(res).toEqual({ stopped: true });
    expect(pm.getStatus('svc')!.status).toBe('stopped');
    // killProcessTree runs detached; let its internal SIGKILL timer fire.
    await jest.advanceTimersByTimeAsync(600);
    expect(killSpy).toHaveBeenCalledWith(1234, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(1234, 'SIGKILL');
  });
});

describe('killProcessTree branches', () => {
  it('returns early when there is no pid', async () => {
    jest.useFakeTimers();
    child = new FakeChild(undefined);
    spawnMock.mockReturnValue(child);
    pm.start('svc', { cwd: '/tmp/app' });
    pm.stop('svc');
    await jest.advanceTimersByTimeAsync(600);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('swallows a pkill failure and still kills the main process', async () => {
    jest.useFakeTimers();
    execImpl = (_cmd, cb) => cb(new Error('pkill missing'), { stdout: '', stderr: '' });
    pm.start('svc', { cwd: '/tmp/app' });
    pm.stop('svc');
    await jest.advanceTimersByTimeAsync(600);
    expect(killSpy).toHaveBeenCalledWith(1234, 'SIGTERM');
  });

  it('swallows a process.kill failure (already dead)', async () => {
    jest.useFakeTimers();
    killSpy.mockImplementation(() => {
      throw new Error('ESRCH');
    });
    pm.start('svc', { cwd: '/tmp/app' });
    expect(() => pm.stop('svc')).not.toThrow();
    await jest.advanceTimersByTimeAsync(600);
  });
});

describe('getStatus', () => {
  it('returns null for an unknown service', () => {
    expect(pm.getStatus('nope')).toBeNull();
  });

  it('returns the full status snapshot', () => {
    pm.start('svc', { cwd: '/tmp/app' });
    const s = pm.getStatus('svc')!;
    expect(s).toMatchObject({ pid: 1234, status: 'running', startedAt: expect.any(Number) });
    expect(s.exitCode).toBeUndefined();
  });
});

describe('getLogs', () => {
  it('returns an empty stopped snapshot for an unknown service', () => {
    expect(pm.getLogs('nope')).toEqual({ logs: [], status: 'stopped' });
  });

  it('returns logs plus metadata for a known service', () => {
    pm.start('svc', { cwd: '/tmp/app' });
    const res = pm.getLogs('svc');
    expect(res).toMatchObject({ logs: [], status: 'running', pid: 1234, startedAt: expect.any(Number) });
  });
});

describe('stopAll', () => {
  it('stops every managed process', async () => {
    jest.useFakeTimers();
    pm.start('a', { cwd: '/tmp/a' });
    const childB = new FakeChild(2222);
    spawnMock.mockReturnValue(childB);
    pm.start('b', { cwd: '/tmp/b' });
    pm.stopAll();
    expect(pm.getStatus('a')!.status).toBe('stopped');
    expect(pm.getStatus('b')!.status).toBe('stopped');
    await jest.advanceTimersByTimeAsync(600);
    expect(killSpy).toHaveBeenCalledWith(1234, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(2222, 'SIGTERM');
  });
});

describe('cleanup', () => {
  it('waits, then force-kills only the still-running processes', async () => {
    jest.useFakeTimers();
    // running process
    pm.start('running', { cwd: '/tmp/r' });
    // a second process that has already exited
    const childDone = new FakeChild(2222);
    spawnMock.mockReturnValue(childDone);
    pm.start('done', { cwd: '/tmp/d' });
    childDone.emit('close', 0); // status -> stopped

    const p = pm.cleanup();
    await jest.advanceTimersByTimeAsync(1000); // initial grace period
    await jest.advanceTimersByTimeAsync(600); // killProcessTree SIGKILL timer
    await p;

    // Only the still-running process's pid was signalled.
    expect(killSpy).toHaveBeenCalledWith(1234, 'SIGTERM');
    expect(killSpy).not.toHaveBeenCalledWith(2222, 'SIGTERM');
  });
});
