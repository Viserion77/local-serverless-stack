// Resolves where the orchestrator lives (baseUrl) and the default region, from
// explicit options → environment → config file → defaults. Mirrors the CLI's
// port handling (bin/cli.js getServerPort / getConfig) but honors the client's
// own configPath/cwd instead of process.argv, which the CLI freezes at load.

import fs from 'fs';
import path from 'path';
import type { LssClientOptions } from './types';

export interface ResolvedConfig {
  baseUrl: string;
  region?: string;
  configPath?: string;
  cwd: string;
  timeoutMs: number;
}

const DEFAULT_PORT = 3100;
const DEFAULT_TIMEOUT_MS = 15000;

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function readServerPortFromConfig(configPath: string | undefined, cwd: string): number {
  const candidates = configPath
    ? [path.resolve(cwd, configPath)]
    : [path.join(cwd, 'lss.config.json'), path.join(cwd, '.lssrc')];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const cfg = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as { serverPort?: number };
        if (typeof cfg.serverPort === 'number') return cfg.serverPort;
      }
    } catch {
      // Unreadable/invalid config — fall through to the next candidate / default.
    }
  }
  return DEFAULT_PORT;
}

function resolveBaseUrl(options: LssClientOptions, configPath: string | undefined, cwd: string): string {
  if (options.baseUrl) return stripTrailingSlash(options.baseUrl);
  if (process.env.LSS_BASE_URL) return stripTrailingSlash(process.env.LSS_BASE_URL);

  const host = options.host ?? 'localhost';
  let port = options.port;
  if (port === undefined && process.env.LSS_SERVER_PORT) {
    // Strict parse + validation: a non-numeric/zero/negative env value falls
    // through to the config file / default rather than yielding "http://host:NaN".
    const parsed = Number(process.env.LSS_SERVER_PORT);
    if (Number.isInteger(parsed) && parsed > 0) port = parsed;
  }
  if (port === undefined) {
    port = readServerPortFromConfig(configPath, cwd);
  }
  return `http://${host}:${port}`;
}

export function resolveConfig(options: LssClientOptions = {}): ResolvedConfig {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? process.env.LSS_CONFIG ?? undefined;
  const region = options.region ?? process.env.AWS_REGION ?? undefined;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseUrl = resolveBaseUrl(options, configPath, cwd);
  return { baseUrl, region, configPath, cwd, timeoutMs };
}
