// Output capture for the runtime worker. The old approach patched console.*
// only, so structured loggers (pino/winston/bunyan) that write straight to the
// stream or to file descriptor 1/2 (pino's sonic-boom does fs.write(1, ...))
// bypassed capture entirely — their invocations showed "logs": [] in the
// dashboard. This module intercepts all three layers:
//
//   console.* ─────────► process.stdout/stderr.write ──► fd 1/2
//   winston et al ─────► process.stdout/stderr.write ──► fd 1/2
//   pino (sonic-boom) ────────────────────────────────► fs.write(Sync)(1|2)
//
// Interception happens synchronously at the write call site, so
// AsyncLocalStorage still knows which invocation emitted the line. Attributed
// output is swallowed (the worker's stdout pipe is otherwise surfaced by the
// manager as *service-level* noise — per-invocation lines travel on the IPC
// result instead); unattributable output passes through to the real fd for
// the manager to forward. console.* keeps its level tag by marking the level
// around the original call and letting the stream patch prefix the line.

import fs from 'fs';

export type LogSink = string[];

export interface OutputCapture {
  // Push a sink's buffered partial line (no trailing newline seen yet) before
  // its invocation result ships.
  flush(sink: LogSink): void;
  // Restore every patched function (tests).
  uninstall(): void;
}

const CONSOLE_LEVELS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];

function decode(chunk: unknown): string | undefined {
  if (typeof chunk === 'string') return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString('utf8');
  if (ArrayBuffer.isView(chunk)) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('utf8');
  }
  return undefined;
}

// The exact bytes an fs.write/writeSync call would put on the fd, honoring
// every calling convention: buffer/TypedArray with positional offset/length,
// the options-object form ({offset, length, position}), and strings with an
// encoding in either trailing slot. `written` must be the true byte count —
// sonic-boom-style writers advance their internal buffer by it.
interface FsWritePayload {
  text: string;
  written: number;
}

function analyzeFsWrite(data: unknown, ...rest: unknown[]): FsWritePayload | undefined {
  if (typeof data === 'string') {
    const encoding = rest.find(
      (arg): arg is BufferEncoding => typeof arg === 'string' && Buffer.isEncoding(arg),
    ) ?? 'utf8';
    const bytes = Buffer.from(data, encoding);
    return { text: bytes.toString('utf8'), written: bytes.length };
  }
  if (!ArrayBuffer.isView(data)) return undefined;
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  let length = buffer.length;
  const [first, second] = rest;
  if (typeof first === 'number') {
    offset = first;
    length = typeof second === 'number' ? second : buffer.length - offset;
  } else if (first !== null && typeof first === 'object') {
    const options = first as { offset?: unknown; length?: unknown };
    if (typeof options.offset === 'number') offset = options.offset;
    length = typeof options.length === 'number' ? options.length : buffer.length - offset;
  }
  const slice = buffer.subarray(offset, offset + length);
  return { text: slice.toString('utf8'), written: slice.length };
}

// The patch must keep the original's properties — fs.write/fs.writev carry
// util.promisify.custom, and dropping it breaks util.promisify(fs.write)
// ({bytesWritten, buffer} result) for EVERY fd, not just stdio.
function adoptProperties<T>(patched: T, original: unknown): T {
  Object.defineProperties(
    patched as object,
    Object.getOwnPropertyDescriptors(original as object),
  );
  return patched;
}

export function installOutputCapture(sinkFor: () => LogSink | undefined): OutputCapture {
  // Partial line (chunk without trailing newline) per sink, completed by the
  // next chunk or flushed when the invocation ends.
  const pending = new WeakMap<LogSink, string>();
  // Set while a patched console method runs, so the stream patch can tag the
  // line with the console level (the historical "INFO <msg>" format).
  let consoleLevel: string | undefined;

  const capture = (sink: LogSink, text: string): void => {
    const combined = (pending.get(sink) ?? '') + text;
    const lines = combined.split('\n');
    pending.set(sink, lines.pop()!);
    for (const raw of lines) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      sink.push(consoleLevel ? `${consoleLevel} ${line}` : line);
    }
  };

  // ---- console.*: level tagging only; the write lands in the stream patch ----
  const realConsole = {} as Record<ConsoleLevel, (...args: unknown[]) => void>;
  for (const level of CONSOLE_LEVELS) {
    const original = console[level].bind(console);
    realConsole[level] = console[level];
    console[level] = (...args: unknown[]) => {
      const previous = consoleLevel;
      consoleLevel = level === 'log' ? 'INFO' : level.toUpperCase();
      try {
        original(...args);
      } finally {
        consoleLevel = previous;
      }
    };
  }

  // ---- stream layer: process.stdout/stderr.write ----
  const patchStream = (stream: NodeJS.WriteStream): (() => void) => {
    const original = stream.write;
    const passthrough = original.bind(stream);
    const patched = (chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
      const sink = sinkFor();
      const text = sink ? decode(chunk) : undefined;
      if (sink && text !== undefined) {
        capture(sink, text);
        const done = typeof encoding === 'function' ? encoding : callback;
        if (typeof done === 'function') process.nextTick(done);
        return true;
      }
      return passthrough(chunk as string, encoding as BufferEncoding, callback as (err?: Error | null) => void);
    };
    stream.write = patched as typeof stream.write;
    return () => {
      stream.write = original;
    };
  };
  const restoreStdout = patchStream(process.stdout);
  const restoreStderr = patchStream(process.stderr);

  // ---- fd layer: fs.write / fs.writeSync / fs.writev / fs.writevSync ----
  const tryCapture = (fd: unknown, data: unknown, rest: unknown[]): number | undefined => {
    if (fd !== 1 && fd !== 2) return undefined;
    const sink = sinkFor();
    if (!sink) return undefined;
    const payload = analyzeFsWrite(data, ...rest);
    if (payload === undefined) return undefined;
    capture(sink, payload.text);
    return payload.written;
  };

  const realWrite = fs.write;
  const realWriteSync = fs.writeSync;
  const realWritev = fs.writev;
  const realWritevSync = fs.writevSync;

  const writePatch = adoptProperties((fd: unknown, data: unknown, ...rest: unknown[]): void => {
    const written = tryCapture(fd, data, rest);
    if (written !== undefined) {
      const callback = rest.find((arg) => typeof arg === 'function');
      // sonic-boom advances its buffer from this callback — the byte count
      // must be accurate or it re-writes the tail forever.
      if (typeof callback === 'function') process.nextTick(callback, null, written, data);
      return;
    }
    (realWrite as unknown as (...args: unknown[]) => void)(fd, data, ...rest);
  }, realWrite);
  fs.write = writePatch as unknown as typeof fs.write;

  const writeSyncPatch = adoptProperties((fd: unknown, data: unknown, ...rest: unknown[]): number => {
    const written = tryCapture(fd, data, rest);
    if (written !== undefined) return written;
    return (realWriteSync as unknown as (...args: unknown[]) => number)(fd, data, ...rest);
  }, realWriteSync);
  fs.writeSync = writeSyncPatch as unknown as typeof fs.writeSync;

  const captureWritev = (fd: unknown, buffers: unknown): number | undefined => {
    if ((fd !== 1 && fd !== 2) || !Array.isArray(buffers)) return undefined;
    const sink = sinkFor();
    if (!sink) return undefined;
    let text = '';
    let written = 0;
    for (const view of buffers as unknown[]) {
      text += decode(view) ?? '';
      written += ArrayBuffer.isView(view) ? view.byteLength : 0;
    }
    capture(sink, text);
    return written;
  };

  const writevPatch = adoptProperties((fd: unknown, buffers: unknown, ...rest: unknown[]): void => {
    const written = captureWritev(fd, buffers);
    if (written !== undefined) {
      const callback = rest.find((arg) => typeof arg === 'function');
      if (typeof callback === 'function') process.nextTick(callback, null, written, buffers);
      return;
    }
    (realWritev as unknown as (...args: unknown[]) => void)(fd, buffers, ...rest);
  }, realWritev);
  fs.writev = writevPatch as unknown as typeof fs.writev;

  const writevSyncPatch = adoptProperties((fd: unknown, buffers: unknown, ...rest: unknown[]): number => {
    const written = captureWritev(fd, buffers);
    if (written !== undefined) return written;
    return (realWritevSync as unknown as (...args: unknown[]) => number)(fd, buffers, ...rest);
  }, realWritevSync);
  fs.writevSync = writevSyncPatch as unknown as typeof fs.writevSync;

  return {
    flush(sink: LogSink): void {
      const remainder = pending.get(sink);
      pending.delete(sink);
      if (remainder) sink.push(remainder);
    },
    uninstall(): void {
      for (const level of CONSOLE_LEVELS) console[level] = realConsole[level];
      restoreStdout();
      restoreStderr();
      fs.write = realWrite;
      fs.writeSync = realWriteSync;
      fs.writev = realWritev;
      fs.writevSync = realWritevSync;
    },
  };
}
