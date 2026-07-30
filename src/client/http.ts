// Minimal HTTP layer for the LSS client. Talks to the orchestrator's `/api/*`
// endpoints over `fetch` (Node >=18). The error mapping mirrors the CLI's
// buildHttpError/formatError (bin/cli.js) so failures carry the orchestrator's
// own `{error|message}` instead of an opaque status.

export class LssHttpError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly body?: string;
  readonly path: string;

  constructor(message: string, info: { status: number; statusText: string; body?: string; path: string }) {
    super(message);
    this.name = 'LssHttpError';
    this.status = info.status;
    this.statusText = info.statusText;
    this.body = info.body;
    this.path = info.path;
  }
}

export type QueryValue = string | number | boolean | undefined;

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, QueryValue>;
  /** Status codes treated as success in addition to 2xx (e.g. await-idle's 408). */
  okStatuses?: number[];
  /**
   * Per-request client timeout, overriding the client default. Required by any
   * endpoint that BLOCKS server-side for a caller-chosen duration: with the
   * shared 15 s default, await-idle's own 15 s default made the client abort at
   * exactly the moment the server would have answered 408.
   */
  timeoutMs?: number;
}

export interface RequestContext {
  baseUrl: string;
  timeoutMs: number;
}

/* istanbul ignore next -- defensive: only runs on connection failure, where the error's message shape varies by runtime */
function reason(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

function buildQuery(query?: Record<string, QueryValue>): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

function isOk(status: number, okStatuses?: number[]): boolean {
  // okStatuses is ADDITIVE to the 2xx range, not a replacement — so passing
  // e.g. [408] still treats a normal 200 as success.
  if (status >= 200 && status < 300) return true;
  return okStatuses ? okStatuses.includes(status) : false;
}

function httpError(status: number, statusText: string, data: string, path: string): LssHttpError {
  let parsed: { error?: unknown; message?: unknown } | null;
  try {
    parsed = data ? JSON.parse(data) : {};
  } catch {
    parsed = null;
  }
  const fromBody = parsed && (parsed.error || parsed.message);
  const label = statusText ? `${status} ${statusText}` : `${status}`;
  let message: string;
  if (fromBody && String(fromBody).trim()) {
    message = String(fromBody).trim();
  } else {
    const snippet = data && data.length < 300 ? data.trim() : '';
    message = snippet ? `HTTP ${label}: ${snippet}` : `HTTP ${label} (no error body)`;
  }
  return new LssHttpError(message, { status, statusText, body: data, path });
}

async function doFetch(
  ctx: RequestContext,
  method: string,
  path: string,
  opts: RequestOptions,
): Promise<Response> {
  const url = ctx.baseUrl + path + buildQuery(opts.query);
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? ctx.timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const hasBody = opts.body !== undefined;
  try {
    return await fetch(url, {
      method,
      headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
      body: hasBody ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    // An aborted fetch rejects with a DOMException named 'AbortError' (not always
    // an Error subclass across Node versions), so match on the name directly.
    const name = (err as { name?: string }).name;
    if (name === 'AbortError') {
      throw new LssHttpError(`request to ${path} timed out after ${timeoutMs}ms`, {
        status: 0,
        statusText: 'timeout',
        path,
      });
    }
    throw new LssHttpError(`could not connect to orchestrator at ${ctx.baseUrl}: ${reason(err)}`, {
      status: 0,
      statusText: 'connection_error',
      path,
    });
  } finally {
    clearTimeout(timer);
  }
}

export class Http {
  constructor(private readonly ctx: RequestContext) {}

  /** Request expecting a JSON response (or an empty body on success). */
  async json<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await doFetch(this.ctx, method, path, opts);
    const text = await res.text();
    if (!isOk(res.status, opts.okStatuses)) {
      throw httpError(res.status, res.statusText, text, path);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Request expecting a raw binary body (e.g. S3 object content). */
  async raw(method: string, path: string, opts: RequestOptions): Promise<Buffer> {
    const res = await doFetch(this.ctx, method, path, opts);
    if (!isOk(res.status, opts.okStatuses)) {
      const text = await res.text();
      throw httpError(res.status, res.statusText, text, path);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}
