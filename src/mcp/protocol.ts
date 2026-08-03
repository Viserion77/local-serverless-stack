// MCP over JSON-RPC 2.0, hand-rolled.
//
// Why not the official SDK: this package ships with a deliberately small
// dependency tree (express, cors, aws-sdk clients) and the stdio transport is
// newline-delimited JSON-RPC — a few dozen lines. Adding an SDK for that would
// cost more than it saves.
//
// This module is pure: `handleMessage` maps a request object to a response
// object and never touches stdio, which is what makes it testable. The
// stdio wiring lives in server.ts.

import { TOOLS_BY_NAME, toolListPayload, type HttpLike } from './tools.js';

// The revision of the MCP spec this server implements. Clients that ask for a
// different one are answered with ours; per the spec they then decide whether
// to continue.
export const PROTOCOL_VERSION = '2024-11-05';

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export const ERROR_CODES = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  internal: -32603,
} as const;

export interface ServerContext {
  http: HttpLike;
  serverName: string;
  serverVersion: string;
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function fail(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function textContent(payload: unknown, isError = false): unknown {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

async function callTool(params: Record<string, unknown>, ctx: ServerContext): Promise<unknown> {
  const toolName = params.name;
  if (typeof toolName !== 'string') {
    return textContent('tools/call requires a "name"', true);
  }
  const tool = TOOLS_BY_NAME.get(toolName);
  if (!tool) {
    return textContent(`Unknown tool: ${toolName}`, true);
  }
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  try {
    return textContent(await tool.run(args, ctx.http));
  } catch (error) {
    // A tool that fails is a normal outcome the model should read and react to
    // — surfaced as an error RESULT, not a transport-level JSON-RPC error.
    return textContent(error instanceof Error ? error.message : String(error), true);
  }
}

/**
 * Handle one decoded JSON-RPC message.
 * Returns `null` for notifications (no `id`), which must not be answered.
 */
export async function handleMessage(
  message: JsonRpcRequest,
  ctx: ServerContext,
): Promise<JsonRpcResponse | null> {
  const id = message.id ?? null;
  const isNotification = message.id === undefined || message.id === null;
  const method = message.method;

  if (typeof method !== 'string') {
    return isNotification ? null : fail(id, ERROR_CODES.invalidRequest, 'missing "method"');
  }

  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: ctx.serverName, version: ctx.serverVersion },
      });
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: toolListPayload() });
    case 'tools/call':
      return ok(id, await callTool(message.params ?? {}, ctx));
    default:
      // Notifications we do not implement (notifications/initialized,
      // notifications/cancelled, ...) are silently accepted, as the spec
      // requires — only a REQUEST for an unknown method is an error.
      return isNotification ? null : fail(id, ERROR_CODES.methodNotFound, `Unknown method: ${method}`);
  }
}

/** Decode a line and dispatch it. Malformed JSON answers a parse error. */
export async function handleLine(line: string, ctx: ServerContext): Promise<JsonRpcResponse | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return fail(null, ERROR_CODES.parse, 'invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail(null, ERROR_CODES.invalidRequest, 'expected a JSON-RPC object');
  }
  return handleMessage(parsed as JsonRpcRequest, ctx);
}
