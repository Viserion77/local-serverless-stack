// Stable local ports for Lambda Web Function endpoints.
//
// On AWS an endpoint's URL is minted once and never changes; locally the URL is
// `http://localhost:<port>`, so the port IS the identity — a sibling function's
// env, a bookmarked tab, a frontend's .env all hold it. It therefore must not
// move between orchestrator restarts or re-registrations. Precedence:
//
//   1. `serviceRuntime.<svc>.webFunctions.<fn>.<endpoint>.port` — pinned;
//   2. the port this endpoint had at its previous registration (persisted in
//      the service cache's metadata);
//   3. the next port of `webFunctions.portRange` that no other endpoint holds
//      and that is free on this host right now.
//
// A pinned or remembered port that another process holds is KEPT (the listener
// reports `port-conflict` and retries, like the API/invoke listeners do): a URL
// that silently moves is worse than one that waits for its port.

import net from 'net';
import { getBindHost } from './bind-host.js';
import type { RegisteredWebFunction } from './web-function-assembler.js';

export interface PortAllocationInput {
  functions: RegisteredWebFunction[];
  // Pinned ports from lss.config.json.
  pinned: (functionName: string, endpointName: string) => number | undefined;
  // `<fn>/<endpoint>` → port, from this service's previous registration.
  previous: Map<string, number>;
  // Ports other services' endpoints already hold.
  taken: Set<number>;
  range: [number, number];
  warnings: string[];
  // Injectable for tests; defaults to a real bind probe.
  isFree?: (port: number) => Promise<boolean>;
}

export function endpointKey(functionName: string, endpointName: string): string {
  return `${functionName}/${endpointName}`;
}

/** Every `<fn>/<endpoint>` → port already assigned in a registration's functions. */
export function assignedPorts(functions: RegisteredWebFunction[] | undefined): Map<string, number> {
  const map = new Map<string, number>();
  for (const fn of functions ?? []) {
    for (const ep of fn.endpoints) {
      if (ep.port !== undefined) map.set(endpointKey(fn.name, ep.name), ep.port);
    }
  }
  return map;
}

/** True when nothing on this host is listening on `port` (bind probe). */
export function probePortFree(port: number, host: string = getBindHost()): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

/**
 * Sets `port` on every endpoint of `functions` (mutating them) and returns the
 * endpoint logical id → port map that `DomainName` resolves from.
 */
export async function allocateWebPorts(input: PortAllocationInput): Promise<Map<string, number>> {
  const isFree = input.isFree ?? (port => probePortFree(port));
  const used = new Set(input.taken);
  const byLogicalId = new Map<string, number>();
  const pending: Array<{ fn: RegisteredWebFunction; index: number }> = [];

  // Pinned and remembered first, so a fresh endpoint never grabs a port an
  // existing one is about to claim.
  for (const fn of input.functions) {
    fn.endpoints.forEach((ep, index) => {
      const key = endpointKey(fn.name, ep.name);
      const pinned = input.pinned(fn.name, ep.name);
      const port = pinned ?? input.previous.get(key);
      if (port === undefined) {
        pending.push({ fn, index });
        return;
      }
      if (used.has(port)) {
        input.warnings.push(
          `[web function ${fn.name}] Endpoint ${ep.name}: port ${port} is also assigned to another endpoint — both will contend for it.`,
        );
      }
      ep.port = port;
      used.add(port);
      byLogicalId.set(ep.logicalId, port);
    });
  }

  const [from, to] = input.range;
  let next = from;
  for (const { fn, index } of pending) {
    const ep = fn.endpoints[index];
    let assigned: number | undefined;
    for (; next <= to; next++) {
      if (used.has(next)) continue;
      if (await isFree(next)) {
        assigned = next++;
        break;
      }
    }
    if (assigned === undefined) {
      input.warnings.push(
        `[web function ${fn.name}] Endpoint ${ep.name}: no free port left in webFunctions.portRange ${from}-${to} — not served. Widen the range or pin a port.`,
      );
      continue;
    }
    ep.port = assigned;
    used.add(assigned);
    byLogicalId.set(ep.logicalId, assigned);
  }
  return byLogicalId;
}

/**
 * `https://localhost:<web port>` → `http://localhost:<web port>` inside env
 * values (also `127.0.0.1`). The template is right for AWS, where TLS ends at
 * the endpoint; the local listener speaks plain HTTP, so an unrewritten URL is
 * a TLS handshake against a socket that cannot answer one. Only ports that are
 * web-function endpoints are touched — any other https URL is left alone.
 */
export function rewriteWebHttps(env: Record<string, string>, ports: Set<number>): Record<string, string> {
  if (ports.size === 0) return env;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    result[key] = value.replace(
      /https:\/\/(localhost|127\.0\.0\.1):(\d+)/g,
      (match, host: string, port: string) => (ports.has(Number(port)) ? `http://${host}:${port}` : match),
    );
  }
  return result;
}
