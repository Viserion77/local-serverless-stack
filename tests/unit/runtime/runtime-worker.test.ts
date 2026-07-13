// End-to-end contract of the runtime worker's log capture: forks the real
// worker (via tsx) and drives it over IPC exactly like the runtime manager
// does. This is the test that fails if per-invocation capture regresses to
// console-only — the fixture writes through console.*, process.stdout.write
// and raw fd writes (the pino/sonic-boom path that used to vanish).
import { fork, ChildProcess } from 'child_process';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const WORKER = path.join(REPO_ROOT, 'src/server/runtime/runtime-worker.ts');
const FIXTURES = path.join(REPO_ROOT, 'tests/fixtures/runtime');

interface WorkerResult {
  type: 'result';
  invokeId: string;
  ok: boolean;
  payload?: unknown;
  error?: { errorType: string; errorMessage: string };
  logs: string[];
  durationMs: number;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('runtime worker log capture (forked)', () => {
  let worker: ChildProcess;
  let stdoutData = '';
  const results = new Map<string, (msg: WorkerResult) => void>();

  beforeAll(async () => {
    worker = fork(WORKER, [], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      execArgv: ['--import', 'tsx'],
    });
    worker.stdout!.on('data', (chunk: Buffer) => { stdoutData += chunk.toString(); });
    worker.stderr!.on('data', () => { /* surfaced by the manager in production */ });
    worker.on('message', (msg: WorkerResult) => {
      if (msg?.type === 'result') results.get(msg.invokeId)?.(msg);
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker did not become ready')), 25000);
      worker.once('message', (msg: { type?: string }) => {
        if (msg?.type === 'ready') {
          clearTimeout(timer);
          resolve();
        }
      });
      worker.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`worker exited before ready (code ${code})`));
      });
    });
  }, 30000);

  afterAll(() => {
    worker?.kill('SIGTERM');
  });

  function invoke(handler: string, invokeId: string): Promise<WorkerResult> {
    return new Promise((resolve) => {
      results.set(invokeId, resolve);
      worker.send({
        type: 'invoke',
        invokeId,
        functionName: 'fixture',
        fullName: 'fixture-service-fixture',
        handler,
        handlerRoot: FIXTURES,
        serviceRoot: FIXTURES,
        timeoutSeconds: 10,
        memorySize: 128,
        region: 'us-east-1',
        env: {},
        event: {},
      });
    });
  }

  it('captures console, stream and fd-level writes in the invocation logs', async () => {
    const result = await invoke('logging-handler.handler', 'inv-logs');
    expect(result.ok).toBe(true);
    expect(result.payload).toMatchObject({ statusCode: 500 });
    expect(result.logs).toEqual(expect.arrayContaining([
      // Cold-start module output attributes to the only in-flight invocation.
      'INFO module init log',
      'INFO hello from console 42',
      'ERROR tagged error',
      'direct stdout write',
      '{"level":30,"msg":"pino-style fd write"}',
      'sync fd write',
      'stderr fd write',
      'partial line reassembled',
    ]));

    // Captured lines are swallowed at the source — they must not double up on
    // the worker's stdout pipe (which the manager logs as service-level).
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(stdoutData).not.toContain('pino-style fd write');
    expect(stdoutData).not.toContain('module init log');
  }, 30000);

  it('passes output written after the invocation completed through to the pipe', async () => {
    const result = await invoke('logging-handler.orphan', 'inv-orphan');
    expect(result.ok).toBe(true);
    expect(result.logs).not.toContain('orphan line after completion');
    await waitFor(
      () => stdoutData.includes('orphan line after completion'),
      5000,
      'orphan line on the stdout pipe',
    );
  }, 30000);

  // Two invocations in flight on the same worker: AsyncLocalStorage must keep
  // each line with the invocation that emitted it (a first-active-sink
  // heuristic would dump quick's lines into slow's record).
  it('attributes logs to the right invocation when two overlap', async () => {
    // IPC messages are processed in order, so slow is in flight (its logs
    // registered) before quick's invoke is even read; the sleep adds margin.
    const slowPromise = invoke('logging-handler.slow', 'inv-slow');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const quick = await invoke('logging-handler.quick', 'inv-quick');
    const slow = await slowPromise;

    expect(quick.logs).toEqual(expect.arrayContaining(['INFO quick-line', 'quick-fd-line']));
    expect(quick.logs).not.toEqual(expect.arrayContaining(['INFO slow-start']));
    expect(quick.logs).not.toEqual(expect.arrayContaining(['slow-fd-line']));
    expect(slow.logs).toEqual(expect.arrayContaining(['INFO slow-start', 'slow-fd-line', 'INFO slow-end']));
    expect(slow.logs).not.toEqual(expect.arrayContaining(['INFO quick-line']));
    expect(slow.logs).not.toEqual(expect.arrayContaining(['quick-fd-line']));
  }, 30000);
});
