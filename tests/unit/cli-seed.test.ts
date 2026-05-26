import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import type { AddressInfo } from 'net';

// These tests exercise bin/cli.js directly by spawning it as a subprocess
// against a stub HTTP server that pretends to be the orchestrator. That lets
// us validate the new confirmation flow, --yes bypass, and the "missing
// tables" hint without needing a real LocalStack or orchestrator running.

const CLI_PATH = path.resolve(__dirname, '../../bin/cli.js');

interface SeedEntry {
  tableName: string;
  file: string;
  itemCount: number;
  tableExists: boolean;
}

interface StubState {
  seedsList: SeedEntry[];
  liveTables: string[];
  clearCalls: Array<{ tableName?: string }>;
  runCalls: Array<{ tableName?: string }>;
  // When set, overrides the default 200 OK response from GET /api/seeds.
  getSeedsResponse?: { status: number; body?: string };
}

interface Stub {
  server: http.Server;
  port: number;
  state: StubState;
  close: () => Promise<void>;
}

function startStubOrchestrator(): Promise<Stub> {
  const state: StubState = {
    seedsList: [],
    liveTables: [],
    clearCalls: [],
    runCalls: [],
  };

  const server = http.createServer((req, res) => {
    const url = req.url ?? '';

    if (req.method === 'GET' && url === '/api/seeds') {
      if (state.getSeedsResponse) {
        res.writeHead(state.getSeedsResponse.status, { 'Content-Type': 'application/json' });
        res.end(state.getSeedsResponse.body ?? '');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          seedsDir: '/tmp/seeds',
          entries: state.seedsList,
          liveTables: state.liveTables,
        }),
      );
      return;
    }

    if (req.method === 'POST' && url === '/api/seeds/clear') {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) : {};
        state.clearCalls.push(parsed);
        const targetNames: string[] = parsed.tableName
          ? [parsed.tableName]
          : state.seedsList.filter(e => e.tableExists).map(e => e.tableName);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            results: targetNames.map(t => ({ tableName: t, deleted: 1 })),
          }),
        );
      });
      return;
    }

    if (req.method === 'POST' && url === '/api/seeds/run') {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) : {};
        state.runCalls.push(parsed);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            results: state.seedsList.map(e =>
              e.tableExists
                ? { tableName: e.tableName, inserted: e.itemCount }
                : {
                    tableName: e.tableName,
                    inserted: 0,
                    skipped: true,
                    reason: 'table does not exist in LocalStack',
                  },
            ),
          }),
        );
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        server,
        port,
        state,
        close: () =>
          new Promise<void>(done => {
            server.close(() => done());
          }),
      });
    });
  });
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runCli(
  args: string[],
  options: { cwd: string; stdin?: string } = { cwd: process.cwd() },
): Promise<RunResult> {
  return new Promise(resolve => {
    const child = spawn('node', [CLI_PATH, ...args], {
      cwd: options.cwd,
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', d => (stdout += d.toString()));
    child.stderr?.on('data', d => (stderr += d.toString()));

    if (options.stdin !== undefined) {
      child.stdin?.write(options.stdin);
      child.stdin?.end();
    }

    child.on('close', code => resolve({ stdout, stderr, exitCode: code }));
  });
}

describe('CLI — seed and seed:clear', () => {
  let stub: Stub;
  let tempDir: string;
  let pidFile: string;

  beforeEach(async () => {
    stub = await startStubOrchestrator();

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-cli-test-'));
    fs.writeFileSync(
      path.join(tempDir, 'lss.config.json'),
      JSON.stringify({ serverPort: stub.port, localstackPort: 4566 }),
    );

    // cli.js looks at `/tmp/lss-orchestrator-<port>.pid` for non-default ports,
    // and `ensureRunningOrExit` only checks that the file exists. Use the test
    // runner's own PID so the file references a real process.
    pidFile = path.join(os.tmpdir(), `lss-orchestrator-${stub.port}.pid`);
    fs.writeFileSync(pidFile, String(process.pid));
  });

  afterEach(async () => {
    await stub.close();
    try {
      fs.unlinkSync(pidFile);
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  describe('error handling robustness', () => {
    it('shows a useful message when the orchestrator returns 500 with empty body', async () => {
      stub.state.getSeedsResponse = { status: 500, body: '' };
      const result = await runCli(['seed:clear'], { cwd: tempDir });

      expect(result.exitCode).toBe(1);
      expect(result.stderr + result.stdout).toContain('Não consegui listar');
      // Critical: the error suffix must NEVER be empty. Match the colon followed
      // by at least one non-whitespace character.
      expect(result.stderr + result.stdout).toMatch(/Não consegui listar.*:\s*\S+/);
      expect(result.stderr + result.stdout).toContain('HTTP 500');
    });

    it('shows a useful message when the orchestrator returns 500 with non-JSON body', async () => {
      stub.state.getSeedsResponse = { status: 500, body: 'Internal Server Error stacktrace...' };
      const result = await runCli(['seed:clear'], { cwd: tempDir });

      expect(result.exitCode).toBe(1);
      expect(result.stderr + result.stdout).toMatch(/Não consegui listar.*:\s*\S+/);
    });

    it('shows a useful message when the orchestrator returns 500 with {error: ""}', async () => {
      stub.state.getSeedsResponse = { status: 500, body: JSON.stringify({ error: '' }) };
      const result = await runCli(['seed:clear'], { cwd: tempDir });

      expect(result.exitCode).toBe(1);
      // Empty error from server should not lead to empty CLI message
      expect(result.stderr + result.stdout).toMatch(/Não consegui listar.*:\s*\S+/);
      expect(result.stderr + result.stdout).toContain('HTTP 500');
    });
  });

  describe('seed:clear', () => {
    it('exits with an error before any prompt when orchestrator is not running', async () => {
      fs.unlinkSync(pidFile);
      const result = await runCli(['seed:clear'], { cwd: tempDir });
      expect(result.exitCode).toBe(1);
      expect(result.stderr + result.stdout).toMatch(/not running/i);
      expect(stub.state.clearCalls).toHaveLength(0);
    });

    it('shows scope summary mentioning LocalStack URL and the AWS safety guarantee', async () => {
      stub.state.seedsList = [
        { tableName: 'Users', file: 'Users.json', itemCount: 3, tableExists: true },
      ];
      const result = await runCli(['seed:clear', '--yes'], { cwd: tempDir });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('ATENÇÃO');
      expect(result.stdout).toMatch(/LocalStack:\s+http:\/\/localhost:4566/);
      expect(result.stdout).toMatch(/não toca em nenhuma conta AWS/i);
    });

    it('skips the prompt with --yes and clears all live tables', async () => {
      stub.state.seedsList = [
        { tableName: 'Users', file: 'Users.json', itemCount: 3, tableExists: true },
        { tableName: 'Orders', file: 'Orders.json', itemCount: 2, tableExists: true },
      ];
      const result = await runCli(['seed:clear', '--yes'], { cwd: tempDir });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('pulando confirmação');
      expect(result.stdout).toContain('Users: 1 item(s) deleted');
      expect(result.stdout).toContain('Orders: 1 item(s) deleted');
      expect(stub.state.clearCalls).toHaveLength(1);
      expect(stub.state.clearCalls[0]).toEqual({});
    });

    it('skips the prompt with the short -y flag', async () => {
      stub.state.seedsList = [
        { tableName: 'Users', file: 'Users.json', itemCount: 3, tableExists: true },
      ];
      const result = await runCli(['seed:clear', '-y'], { cwd: tempDir });

      expect(result.exitCode).toBe(0);
      expect(stub.state.clearCalls).toHaveLength(1);
    });

    it('proceeds when the user types exactly "confirmar"', async () => {
      stub.state.seedsList = [
        { tableName: 'Users', file: 'Users.json', itemCount: 3, tableExists: true },
      ];
      const result = await runCli(['seed:clear'], {
        cwd: tempDir,
        stdin: 'confirmar\n',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Users: 1 item(s) deleted');
      expect(stub.state.clearCalls).toHaveLength(1);
    });

    it('cancels when the user types anything other than "confirmar"', async () => {
      stub.state.seedsList = [
        { tableName: 'Users', file: 'Users.json', itemCount: 3, tableExists: true },
      ];
      const result = await runCli(['seed:clear'], {
        cwd: tempDir,
        stdin: 'sim\n',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Cancelado');
      expect(stub.state.clearCalls).toHaveLength(0);
    });

    it('cancels on an empty answer (just Enter)', async () => {
      stub.state.seedsList = [
        { tableName: 'Users', file: 'Users.json', itemCount: 3, tableExists: true },
      ];
      const result = await runCli(['seed:clear'], {
        cwd: tempDir,
        stdin: '\n',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Cancelado');
      expect(stub.state.clearCalls).toHaveLength(0);
    });

    it('rejects "confirmar" with surrounding noise (must match exactly after trim)', async () => {
      stub.state.seedsList = [
        { tableName: 'Users', file: 'Users.json', itemCount: 3, tableExists: true },
      ];
      const result = await runCli(['seed:clear'], {
        cwd: tempDir,
        stdin: 'confirmar sim\n',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Cancelado');
      expect(stub.state.clearCalls).toHaveLength(0);
    });

    it('exits early without prompting when there are seed files but no matching live tables', async () => {
      stub.state.seedsList = [
        { tableName: 'Ghost', file: 'Ghost.json', itemCount: 3, tableExists: false },
      ];
      stub.state.liveTables = [];
      const result = await runCli(['seed:clear'], { cwd: tempDir });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('NENHUMA das tabelas correspondentes existe no LocalStack');
      expect(result.stdout).toContain('Ghost');
      expect(stub.state.clearCalls).toHaveLength(0);
    });

    it('shows seedsDir is empty when there are no seed files at all', async () => {
      stub.state.seedsList = [];
      stub.state.liveTables = ['some-other-table'];
      const result = await runCli(['seed:clear'], { cwd: tempDir });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Nenhum arquivo de seed');
      expect(stub.state.clearCalls).toHaveLength(0);
    });

    it('shows the seed→livetable mismatch diagnostic when names don\'t match', async () => {
      // The pro-sample-microservice bug: seed files use one prefix, real tables use another.
      stub.state.seedsList = [
        {
          tableName: 'sample-microservice-Users',
          file: 'sample-microservice-Users.json',
          itemCount: 3,
          tableExists: false,
        },
        {
          tableName: 'sample-microservice-Orders',
          file: 'sample-microservice-Orders.json',
          itemCount: 2,
          tableExists: false,
        },
      ];
      stub.state.liveTables = [
        'pro-sample-microservice-Users',
        'pro-sample-microservice-Orders',
        'pro-sample-microservice-Sessions',
      ];
      const result = await runCli(['seed:clear'], { cwd: tempDir });

      expect(result.exitCode).toBe(0);
      // Both sides of the mismatch are listed:
      expect(result.stdout).toContain('sample-microservice-Users');
      expect(result.stdout).toContain('sample-microservice-Orders');
      expect(result.stdout).toContain('pro-sample-microservice-Users');
      expect(result.stdout).toContain('pro-sample-microservice-Sessions');
      // And the actionable hint about TableName matching:
      expect(result.stdout).toMatch(/bater EXATAMENTE com.*TableName/);
      expect(stub.state.clearCalls).toHaveLength(0);
    });

    it('exits early when the requested specific table does not exist in LocalStack', async () => {
      stub.state.seedsList = [
        { tableName: 'Users', file: 'Users.json', itemCount: 3, tableExists: true },
      ];
      const result = await runCli(['seed:clear', 'Orders'], { cwd: tempDir });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Nenhuma tabela "Orders"');
      expect(stub.state.clearCalls).toHaveLength(0);
    });

    it('targets a specific table when given as argument', async () => {
      stub.state.seedsList = [
        { tableName: 'Users', file: 'Users.json', itemCount: 3, tableExists: true },
        { tableName: 'Orders', file: 'Orders.json', itemCount: 2, tableExists: true },
      ];
      const result = await runCli(['seed:clear', 'Users', '--yes'], { cwd: tempDir });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Users: 1 item(s) deleted');
      expect(result.stdout).not.toContain('Orders:');
      expect(stub.state.clearCalls).toHaveLength(1);
      expect(stub.state.clearCalls[0]).toEqual({ tableName: 'Users' });
    });
  });

  describe('seed', () => {
    it('seeds all tables that exist in LocalStack', async () => {
      stub.state.seedsList = [
        { tableName: 'Users', file: 'Users.json', itemCount: 3, tableExists: true },
        { tableName: 'Orders', file: 'Orders.json', itemCount: 5, tableExists: true },
      ];
      const result = await runCli(['seed'], { cwd: tempDir });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Users: 3 item(s) inserted');
      expect(result.stdout).toContain('Orders: 5 item(s) inserted');
      expect(result.stdout).not.toContain('foram puladas');
      expect(stub.state.runCalls).toHaveLength(1);
    });

    it('prints the deploy hint when missing tables and zero live tables', async () => {
      stub.state.seedsList = [
        { tableName: 'Users', file: 'Users.json', itemCount: 3, tableExists: true },
        { tableName: 'Orders', file: 'Orders.json', itemCount: 5, tableExists: false },
        { tableName: 'Products', file: 'Products.json', itemCount: 2, tableExists: false },
      ];
      stub.state.liveTables = ['Users'];
      const result = await runCli(['seed'], { cwd: tempDir });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Users: 3 item(s) inserted');
      // The diagnostic now lists live tables (since some exist):
      expect(result.stdout).toContain('Tabelas vivas no LocalStack');
      expect(result.stdout).toMatch(/bater EXATAMENTE/);
    });

    it('shows the deploy-the-stack hint when no live tables exist at all', async () => {
      stub.state.seedsList = [
        { tableName: 'Users', file: 'Users.json', itemCount: 3, tableExists: false },
      ];
      stub.state.liveTables = [];
      const result = await runCli(['seed'], { cwd: tempDir });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Nenhuma tabela viva no LocalStack');
      expect(result.stdout).toContain('npx lss start');
      expect(result.stdout).toContain('serverless deploy');
    });

    it('targets a specific table when given as argument', async () => {
      stub.state.seedsList = [
        { tableName: 'Users', file: 'Users.json', itemCount: 3, tableExists: true },
      ];
      const result = await runCli(['seed', 'Users'], { cwd: tempDir });

      expect(result.exitCode).toBe(0);
      expect(stub.state.runCalls).toHaveLength(1);
      expect(stub.state.runCalls[0]).toEqual({ tableName: 'Users' });
    });

    it('does not print the missing-table hint for unrelated skip reasons', async () => {
      stub.state.seedsList = [];
      // Force a custom response by stubbing an "empty seed file" reason.
      // Override the /api/seeds/run handler for this single test.
      stub.server.removeAllListeners('request');
      stub.server.on('request', (req, res) => {
        if (req.method === 'POST' && req.url === '/api/seeds/run') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              results: [
                {
                  tableName: 'Empty',
                  inserted: 0,
                  skipped: true,
                  reason: 'empty seed file',
                },
              ],
            }),
          );
          return;
        }
        res.writeHead(404);
        res.end();
      });

      const result = await runCli(['seed'], { cwd: tempDir });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Empty: skipped (empty seed file)');
      expect(result.stdout).not.toContain('foram puladas');
    });
  });
});
