// The stdio seam. Two invariants a broken MCP server usually violates:
// responses are newline-framed one per line, and notifications produce NO line
// at all — an extra frame desynchronises every client.
import { PassThrough } from 'stream';
import { startStdioServer } from '../../../src/mcp/server';

function harness(http = async () => ({ ok: true })) {
  const input = new PassThrough();
  const chunks: string[] = [];
  const output = { write: (chunk: string) => { chunks.push(chunk); return true; } };
  startStdioServer(
    { http, serverName: 'lss', serverVersion: '1.2.3' },
    input as never,
    output as never,
  );
  return { input, chunks };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

describe('startStdioServer', () => {
  it('answers one newline-framed JSON-RPC response per request', async () => {
    const { input, chunks } = harness();
    input.write('{"id":1,"method":"ping"}\n');
    await settle();
    expect(chunks).toEqual(['{"jsonrpc":"2.0","id":1,"result":{}}\n']);
  });

  it('writes nothing for a notification or a blank line', async () => {
    const { input, chunks } = harness();
    input.write('\n');
    input.write('   \n');
    input.write('{"method":"notifications/initialized"}\n');
    await settle();
    expect(chunks).toEqual([]);
  });

  it('preserves request order even when an earlier tool is slower', async () => {
    const delays = [30, 0];
    let call = 0;
    const http = jest.fn(async () => {
      const wait = delays[call++] ?? 0;
      await new Promise(resolve => setTimeout(resolve, wait));
      return { call };
    });
    const { input, chunks } = harness(http as never);
    input.write('{"id":"slow","method":"tools/call","params":{"name":"lss_health"}}\n');
    input.write('{"id":"fast","method":"tools/call","params":{"name":"lss_services"}}\n');
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(chunks).toHaveLength(2);
    expect(JSON.parse(chunks[0]).id).toBe('slow');
    expect(JSON.parse(chunks[1]).id).toBe('fast');
  });

  it('reports an unexpected failure on stderr without killing the stream', async () => {
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const input = new PassThrough();
    const output = {
      write: jest.fn((chunk: string) => {
        if (chunk.includes('"boom"')) throw new Error('stdout exploded');
        return true;
      }),
    };
    startStdioServer(
      { http: async () => ({ ok: true }), serverName: 'lss', serverVersion: '1' },
      input as never,
      output as never,
    );
    input.write('{"id":"boom","method":"ping"}\n');
    await settle();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('[lss-mcp] unhandled'));
    // The reader survives: a following request is still answered.
    input.write('{"id":"next","method":"ping"}\n');
    await settle();
    expect(output.write).toHaveBeenCalledWith(expect.stringContaining('"next"'));
    stderr.mockRestore();
  });

  it('stringifies a non-Error failure instead of losing it', async () => {
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const input = new PassThrough();
    const output = { write: () => { throw 'not-an-error'; } };
    startStdioServer(
      { http: async () => ({ ok: true }), serverName: 'lss', serverVersion: '1' },
      input as never,
      output as never,
    );
    input.write('{"id":1,"method":"ping"}\n');
    await settle();
    expect(stderr).toHaveBeenCalledWith('[lss-mcp] unhandled: not-an-error\n');
    stderr.mockRestore();
  });

  it('exits cleanly once stdin closes and the queue has drained', async () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const { input } = harness();
    input.write('{"id":1,"method":"ping"}\n');
    input.end();
    await settle();
    await settle();
    expect(exit).toHaveBeenCalledWith(0);
    exit.mockRestore();
  });
});
