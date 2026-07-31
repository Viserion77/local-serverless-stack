// Where the MCP server finds the orchestrator, and how it talks to it.
//
// Resolution mirrors the LssClient (src/client/config-discovery.ts) so both
// entry points agree: an explicit base URL wins, then the serverPort from the
// project's config file, then the documented default. The MCP process is
// started by the editor from the project directory, so the cwd lookup is the
// case that matters in practice.

import fs from 'fs';
import path from 'path';

const DEFAULT_PORT = 14566;
const DEFAULT_TIMEOUT_MS = 130_000; // above await-idle's 120 s server-side clamp

export interface ResolveOptions {
  baseUrl?: string;
  cwd?: string;
  configPath?: string;
}

function readServerPort(cwd: string, configPath?: string): number {
  const candidates = configPath
    ? [path.resolve(cwd, configPath)]
    : [path.join(cwd, 'lss.config.json'), path.join(cwd, '.lssrc')];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as { serverPort?: unknown };
      if (typeof parsed.serverPort === 'number' && Number.isInteger(parsed.serverPort)) {
        return parsed.serverPort;
      }
    } catch {
      // Unreadable or unparseable: fall through to the next candidate.
    }
  }
  return DEFAULT_PORT;
}

export function resolveBaseUrl(options: ResolveOptions = {}): string {
  const explicit = options.baseUrl ?? process.env.LSS_BASE_URL;
  if (explicit) return explicit.endsWith('/') ? explicit.slice(0, -1) : explicit;
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? process.env.LSS_CONFIG;
  return `http://localhost:${readServerPort(cwd, configPath)}`;
}

export class LssUnreachableError extends Error {}

/**
 * Minimal JSON HTTP caller over global fetch (Node >= 20).
 * A non-2xx answer throws with the orchestrator's own error message, so the
 * model sees "Queue not found" rather than "HTTP 404".
 */
export function createHttp(baseUrl: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return async function http(method: string, urlPath: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(baseUrl + urlPath, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const reason = (error as { name?: string }).name === 'AbortError'
        ? `timed out after ${timeoutMs}ms`
        : (error as Error).message;
      throw new LssUnreachableError(
        `Could not reach the LSS orchestrator at ${baseUrl} (${reason}). `
        + 'Start it with `npx lss start` in the project directory, or set LSS_BASE_URL.',
      );
    } finally {
      clearTimeout(timer);
    }

    const raw = await response.text();
    let parsed: unknown = raw;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      // Keep the raw text — the caller reports it verbatim.
    }
    // await-idle answers 408 with a meaningful body (`drained: false`); that is
    // a result, not a failure.
    if (!response.ok && response.status !== 408) {
      const detail = parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : raw.slice(0, 300) || response.statusText;
      throw new Error(`${method} ${urlPath} → ${response.status}: ${detail}`);
    }
    return parsed;
  };
}
