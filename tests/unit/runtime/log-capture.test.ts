// The output-capture mechanism behind per-invocation Lambda logs: console.*,
// process.stdout/stderr.write AND fd-level fs.write(Sync)/writev(Sync) — the
// path pino's sonic-boom uses — must all land in the resolved sink, keeping
// AsyncLocalStorage attribution, while unattributable output passes through.
import fs from 'fs';
import os from 'os';
import path from 'path';
import util from 'util';
import { Console } from 'console';
import { AsyncLocalStorage } from 'async_hooks';
import { installOutputCapture } from '../../../src/server/runtime/log-capture';
import type { LogSink, OutputCapture } from '../../../src/server/runtime/log-capture';

describe('installOutputCapture', () => {
  const als = new AsyncLocalStorage<LogSink>();
  let capture: OutputCapture;
  let fallback: LogSink | undefined;
  let sink: LogSink;

  const realConsoleLog = console.log;
  const realStdoutWrite = process.stdout.write;
  const realFsWrite = fs.write;

  beforeEach(() => {
    sink = [];
    fallback = undefined;
    capture = installOutputCapture(() => als.getStore() ?? fallback);
  });

  afterEach(() => {
    capture.uninstall();
  });

  const run = (fn: () => void) => als.run(sink, fn);

  // Jest replaces the global console (and --silent installs one that never
  // writes to the streams at all), so this test swaps in a real Node Console
  // for the install — making the exact "LEVEL <msg>" format deterministic
  // under any jest configuration.
  it('tags console output with the level and formats arguments', () => {
    capture.uninstall();
    const previousConsole = globalThis.console;
    globalThis.console = new Console({ stdout: process.stdout, stderr: process.stderr });
    try {
      capture = installOutputCapture(() => als.getStore() ?? fallback);
      run(() => {
        console.log('hello %s', 'world');
        console.info('info line');
        console.warn('warn line');
        console.error('error line');
        console.debug('debug line');
      });
      expect(sink).toEqual([
        'INFO hello world',
        'INFO info line',
        'WARN warn line',
        'ERROR error line',
        'DEBUG debug line',
      ]);
    } finally {
      capture.uninstall();
      globalThis.console = previousConsole;
      capture = installOutputCapture(() => als.getStore() ?? fallback);
    }
  });

  it('captures direct stream writes without a level tag', (done) => {
    run(() => {
      process.stdout.write('raw stdout\n');
      process.stderr.write(Buffer.from('raw stderr\n'), () => {
        expect(sink).toEqual(['raw stdout', 'raw stderr']);
        done();
      });
    });
  });

  it('captures fd-level fs.write — the sonic-boom/pino path — and reports bytes written', (done) => {
    const line = JSON.stringify({ level: 30, msg: 'pino line' }) + '\n';
    run(() => {
      fs.write(1, line, (err, written) => {
        expect(err).toBeNull();
        expect(written).toBe(Buffer.byteLength(line));
        expect(sink).toEqual([line.trimEnd()]);
        done();
      });
    });
  });

  it('captures fs.writeSync on fds 1 and 2, honoring buffer offset/length', () => {
    run(() => {
      expect(fs.writeSync(1, 'sync line\n')).toBe(10);
      const buffer = Buffer.from('xxpartialyy');
      fs.writeSync(2, buffer, 2, 7);
    });
    capture.flush(sink);
    expect(sink).toEqual(['sync line', 'partial']);
  });

  it('captures fs.writev and fs.writevSync concatenating the buffers', (done) => {
    run(() => {
      expect(fs.writevSync(1, [Buffer.from('a'), Buffer.from('b\n')])).toBe(3);
      fs.writev(1, [Buffer.from('c'), Buffer.from('d\n')], (err, written) => {
        expect(err).toBeNull();
        expect(written).toBe(3);
        expect(sink).toEqual(['ab', 'cd']);
        done();
      });
    });
  });

  it('reports the true byte count for non-utf8 encodings and buffers', (done) => {
    run(() => {
      // 'hello\n' in utf16le is 12 bytes on the wire, not 6.
      fs.write(1, 'hello\n', null, 'utf16le', (err, written) => {
        expect(err).toBeNull();
        expect(written).toBe(12);
        // A non-UTF8 byte still counts as 1 written byte even though the
        // captured text decodes it to U+FFFD (3 bytes in utf8).
        expect(fs.writeSync(1, Buffer.from([0xff, 0x0a]))).toBe(2);
        expect(fs.writevSync(1, [Buffer.from([0xff]), Buffer.from('\n')])).toBe(2);
        done();
      });
    });
  });

  it('honors the options-object form and non-Buffer TypedArrays', () => {
    run(() => {
      const bytes = new TextEncoder().encode('xxwindow\nyy');
      // fs.write(fd, buffer, {offset, length}) form via writeSync.
      expect(fs.writeSync(1, Buffer.from(bytes), { offset: 2, length: 7 } as never)).toBe(7);
      // Plain Uint8Array with positional offset/length.
      expect(fs.writeSync(2, bytes, 2, 7)).toBe(7);
    });
    expect(sink).toEqual(['window', 'window']);
  });

  it('keeps util.promisify(fs.write) working while patched', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lss-log-capture-')), 'promisify.txt');
    const fd = fs.openSync(file, 'w');
    try {
      const promisified = util.promisify(fs.write) as unknown as
        (fd: number, buffer: Buffer) => Promise<{ bytesWritten: number }>;
      const result = await promisified(fd, Buffer.from('via promisify\n'));
      expect(result.bytesWritten).toBe(14);
    } finally {
      fs.closeSync(fd);
    }
    expect(fs.readFileSync(file, 'utf8')).toBe('via promisify\n');
  });

  it('reassembles lines split across chunks and strips CR', () => {
    run(() => {
      process.stdout.write('partial ');
      process.stdout.write('rest\r\nnext\n');
    });
    expect(sink).toEqual(['partial rest', 'next']);
  });

  it('flush pushes a trailing partial line once', () => {
    run(() => {
      process.stdout.write('no newline');
    });
    expect(sink).toEqual([]);
    capture.flush(sink);
    capture.flush(sink);
    expect(sink).toEqual(['no newline']);
  });

  it('uses the fallback sink when no store is active', () => {
    fallback = sink;
    process.stdout.write('cold start line\n');
    expect(sink).toEqual(['cold start line']);
  });

  it('passes writes through untouched when no sink resolves', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lss-log-capture-')), 'out.txt');
    const fd = fs.openSync(file, 'w');
    try {
      // Non-stdio fd inside a context: never captured.
      run(() => fs.writeSync(fd, 'to a real file\n'));
      // Stdio write with no sink: reaches the real stream.
      expect(typeof process.stdout.write('')).toBe('boolean');
    } finally {
      fs.closeSync(fd);
    }
    expect(fs.readFileSync(file, 'utf8')).toBe('to a real file\n');
    expect(sink).toEqual([]);
  });

  it('uninstall restores every patched function', () => {
    capture.uninstall();
    expect(console.log).toBe(realConsoleLog);
    expect(process.stdout.write).toBe(realStdoutWrite);
    expect(fs.write).toBe(realFsWrite);
    // Reinstall so afterEach's uninstall stays balanced.
    capture = installOutputCapture(() => undefined);
  });
});
