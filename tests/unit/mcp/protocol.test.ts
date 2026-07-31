// MCP JSON-RPC layer. The contract that matters: a client's handshake works,
// notifications are never answered (answering one desynchronises the stream),
// and a failing tool comes back as an error RESULT rather than a transport
// error — so the model reads the message instead of the client aborting.
import {
  handleLine,
  handleMessage,
  ERROR_CODES,
  PROTOCOL_VERSION,
  type ServerContext,
} from '../../../src/mcp/protocol';

function ctx(http: ServerContext['http'] = async () => ({ ok: true })): ServerContext {
  return { http, serverName: 'lss', serverVersion: '9.9.9' };
}

describe('handshake', () => {
  it('initialize advertises the tools capability and the server identity', async () => {
    const res = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' }, ctx());
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'lss', version: '9.9.9' },
      },
    });
  });

  it('ping answers an empty result', async () => {
    expect(await handleMessage({ id: 'p', method: 'ping' }, ctx())).toEqual({
      jsonrpc: '2.0',
      id: 'p',
      result: {},
    });
  });

  it('notifications are never answered', async () => {
    expect(await handleMessage({ method: 'notifications/initialized' }, ctx())).toBeNull();
    expect(await handleMessage({ method: 'notifications/cancelled', id: null }, ctx())).toBeNull();
    // Including a notification with no method at all.
    expect(await handleMessage({}, ctx())).toBeNull();
  });

  it('a request with no method, or an unknown method, is a JSON-RPC error', async () => {
    expect(await handleMessage({ id: 2 }, ctx())).toMatchObject({
      error: { code: ERROR_CODES.invalidRequest },
    });
    expect(await handleMessage({ id: 3, method: 'resources/list' }, ctx())).toMatchObject({
      error: { code: ERROR_CODES.methodNotFound, message: 'Unknown method: resources/list' },
    });
  });
});

describe('tools/list', () => {
  it('lists tools with a name, a description and an object input schema, and never leaks `run`', async () => {
    const res = await handleMessage({ id: 4, method: 'tools/list' }, ctx());
    const tools = (res as { result: { tools: Record<string, unknown>[] } }).result.tools;
    expect(tools.length).toBeGreaterThan(10);
    for (const tool of tools) {
      expect(typeof tool.name).toBe('string');
      expect((tool.description as string).length).toBeGreaterThan(20);
      expect((tool.inputSchema as { type: string }).type).toBe('object');
      expect(tool).not.toHaveProperty('run');
      expect(tool).not.toHaveProperty('mutates');
    }
    expect(tools.map(t => t.name)).toContain('lss_health');
  });
});

describe('tools/call', () => {
  it('returns the tool payload as pretty-printed JSON text', async () => {
    const http = jest.fn(async () => ({ status: 'ok' }));
    const res = await handleMessage(
      { id: 5, method: 'tools/call', params: { name: 'lss_health', arguments: {} } },
      ctx(http),
    );
    expect(http).toHaveBeenCalledWith('GET', '/api/health');
    expect((res as { result: unknown }).result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ status: 'ok' }, null, 2) }],
    });
  });

  it('defaults missing params and arguments to empty', async () => {
    const http = jest.fn(async () => []);
    await handleMessage({ id: 6, method: 'tools/call', params: { name: 'lss_lambdas' } }, ctx(http));
    expect(http).toHaveBeenCalledWith('GET', '/api/lambdas');
    const res = await handleMessage({ id: 7, method: 'tools/call' }, ctx(http));
    expect((res as { result: { isError: boolean } }).result.isError).toBe(true);
  });

  it('an unknown tool is an error RESULT, not a JSON-RPC error', async () => {
    const res = await handleMessage(
      { id: 8, method: 'tools/call', params: { name: 'lss_nope' } },
      ctx(),
    );
    expect(res).not.toHaveProperty('error');
    expect((res as { result: unknown }).result).toEqual({
      content: [{ type: 'text', text: 'Unknown tool: lss_nope' }],
      isError: true,
    });
  });

  it('a non-string tool name is rejected as an error result', async () => {
    const res = await handleMessage(
      { id: 9, method: 'tools/call', params: { name: 42 } },
      ctx(),
    );
    expect((res as { result: { isError: boolean } }).result.isError).toBe(true);
  });

  it('a throwing tool surfaces the orchestrator message the model needs', async () => {
    const http = jest.fn(async () => {
      throw new Error('GET /api/queues/ghost → 404: Queue not found');
    });
    const res = await handleMessage(
      { id: 10, method: 'tools/call', params: { name: 'lss_queues' } },
      ctx(http),
    );
    expect((res as { result: { content: { text: string }[]; isError: boolean } }).result).toEqual({
      content: [{ type: 'text', text: 'GET /api/queues/ghost → 404: Queue not found' }],
      isError: true,
    });
  });

  it('a thrown non-Error is stringified rather than lost', async () => {
    const http = jest.fn(async () => {
      throw 'boom';
    });
    const res = await handleMessage(
      { id: 11, method: 'tools/call', params: { name: 'lss_queues' } },
      ctx(http as never),
    );
    expect((res as { result: { content: { text: string }[] } }).result.content[0].text).toBe('boom');
  });
});

describe('handleLine', () => {
  it('decodes and dispatches a framed request', async () => {
    const res = await handleLine('{"id":1,"method":"ping"}', ctx());
    expect(res).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
  });

  it('malformed JSON answers a parse error on the null id', async () => {
    expect(await handleLine('{not json', ctx())).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: ERROR_CODES.parse, message: 'invalid JSON' },
    });
  });

  it('a valid JSON non-object is an invalid request', async () => {
    for (const line of ['[1,2]', '"hello"', 'null']) {
      expect(await handleLine(line, ctx())).toMatchObject({
        error: { code: ERROR_CODES.invalidRequest },
      });
    }
  });
});
