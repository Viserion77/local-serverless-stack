#!/usr/bin/env node
// MCP stdio entry point — `npx lss mcp`.
//
// Transport per the MCP spec: newline-delimited JSON-RPC 2.0 on stdin/stdout.
// stdout carries ONLY protocol frames (any stray write corrupts the stream), so
// diagnostics go to stderr, which the client surfaces as server logs.
//
// Kept thin on purpose: the protocol and the tools are pure modules with their
// own tests; this file is the I/O seam.

import { createInterface } from 'readline';
import { createHttp, resolveBaseUrl } from './http.js';
import { handleLine, type ServerContext } from './protocol.js';

export function startStdioServer(
  ctx: ServerContext,
  input: NodeJS.ReadableStream,
  output: { write(chunk: string): unknown },
): void {
  const lines = createInterface({ input, terminal: false });
  // Requests are handled in arrival order: a queue keeps a slow tool from
  // letting a later, faster one answer first. MCP clients tolerate
  // out-of-order responses, but ordered output makes transcripts readable.
  let chain: Promise<void> = Promise.resolve();

  lines.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    chain = chain.then(async () => {
      const response = await handleLine(trimmed, ctx);
      if (response) output.write(`${JSON.stringify(response)}\n`);
    }).catch(error => {
      process.stderr.write(`[lss-mcp] unhandled: ${error instanceof Error ? error.stack : String(error)}\n`);
    });
  });

  lines.on('close', () => {
    void chain.then(() => process.exit(0));
  });
}

/* istanbul ignore next: process entry point, exercised by the CLI smoke test */
export function main(version: string): void {
  const baseUrl = resolveBaseUrl();
  process.stderr.write(`[lss-mcp] orchestrator: ${baseUrl}\n`);
  startStdioServer(
    { http: createHttp(baseUrl), serverName: 'lss', serverVersion: version },
    process.stdin,
    process.stdout,
  );
}
