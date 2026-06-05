// Unit tests for the serverless-lss plugin (packages/serverless-plugin/src/index.ts).
// The plugin is CommonJS (`module.exports = class`), so we require the TS source
// directly (ts-jest transforms + instruments it for coverage).

/* eslint-disable @typescript-eslint/no-explicit-any */
const Plugin = require('../../../packages/serverless-plugin/src/index');

function makeServerless(overrides: any = {}) {
  return {
    config: { servicePath: '/svc/path', service: 'cfg-service' },
    service: {
      service: 'my-service',
      custom: {},
      provider: { region: 'us-east-1' },
      ...overrides.service,
    },
    ...overrides,
  };
}

describe('serverless-lss plugin', () => {
  const ENV = { ...process.env };
  let fetchMock: jest.Mock;

  beforeEach(() => {
    // Clean env so precedence tests are deterministic.
    delete process.env.ORCHESTRATOR_URL;
    delete process.env.LSS_DASHBOARD_PORT;
    delete process.env.ORCHESTRATOR_ENABLED;
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ resourcesCount: 3 }),
    });
    (global as any).fetch = fetchMock;
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...ENV };
  });

  describe('orchestratorUrl precedence', () => {
    it('defaults to http://localhost:3100', () => {
      const p = new Plugin(makeServerless(), {});
      expect(p.orchestratorUrl).toBe('http://localhost:3100');
    });

    it('uses custom.orchestrator.orchestratorUrl when set', () => {
      const p = new Plugin(
        makeServerless({ service: { custom: { orchestrator: { orchestratorUrl: 'http://localhost:4000' } } } }),
        {},
      );
      expect(p.orchestratorUrl).toBe('http://localhost:4000');
    });

    it('options override custom', () => {
      const p = new Plugin(
        makeServerless({ service: { custom: { orchestrator: { orchestratorUrl: 'http://localhost:4000' } } } }),
        { orchestratorUrl: 'http://localhost:5000' },
      );
      expect(p.orchestratorUrl).toBe('http://localhost:5000');
    });

    it('LSS_DASHBOARD_PORT builds the localhost URL', () => {
      process.env.LSS_DASHBOARD_PORT = '3200';
      const p = new Plugin(makeServerless(), {});
      expect(p.orchestratorUrl).toBe('http://localhost:3200');
    });

    it('ORCHESTRATOR_URL wins over LSS_DASHBOARD_PORT', () => {
      process.env.ORCHESTRATOR_URL = 'http://host:9000';
      process.env.LSS_DASHBOARD_PORT = '3200';
      const p = new Plugin(makeServerless(), {});
      expect(p.orchestratorUrl).toBe('http://host:9000');
    });
  });

  describe('enabled flag', () => {
    it('is enabled by default', () => {
      expect(new Plugin(makeServerless(), {}).enabled).toBe(true);
    });

    it('ORCHESTRATOR_ENABLED=false disables', () => {
      process.env.ORCHESTRATOR_ENABLED = 'false';
      expect(new Plugin(makeServerless(), {}).enabled).toBe(false);
    });

    it('ORCHESTRATOR_ENABLED=true keeps enabled', () => {
      process.env.ORCHESTRATOR_ENABLED = 'true';
      expect(new Plugin(makeServerless(), {}).enabled).toBe(true);
    });

    it('enabled:false via custom disables', () => {
      const p = new Plugin(makeServerless({ service: { custom: { orchestrator: { enabled: false } } } }), {});
      expect(p.enabled).toBe(false);
    });
  });

  it('registers the lifecycle hooks', () => {
    const p = new Plugin(makeServerless(), {});
    expect(Object.keys(p.hooks)).toEqual(
      expect.arrayContaining(['after:package:finalize', 'before:offline:start', 'before:offline:start:init']),
    );
  });

  it('constructs with default options (no second arg) and a service without custom', () => {
    // Covers the `options = {}` default param and the `service?.custom || {}` fallback.
    const p = new Plugin({ config: { servicePath: '/x', service: 'c' }, service: undefined } as any);
    expect(p.orchestratorUrl).toBe('http://localhost:3100');
    expect(p.enabled).toBe(true);
  });

  it('log() defaults the type to info when called with one arg', () => {
    const p = new Plugin(makeServerless(), {});
    expect(() => (p as any).log('hello')).not.toThrow();
  });

  describe('registerWithOrchestrator', () => {
    it('no-ops when disabled (no fetch)', async () => {
      process.env.ORCHESTRATOR_ENABLED = 'false';
      const p = new Plugin(makeServerless(), {});
      await p.hooks['after:package:finalize']();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('POSTs to /api/services/register with servicePath, invokePort and region', async () => {
      const sls = makeServerless({
        service: {
          provider: { region: 'sa-east-1' },
          custom: { 'serverless-offline': { lambdaPort: 3010 } },
        },
      });
      const p = new Plugin(sls, {});
      await p.hooks['before:offline:start']();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('http://localhost:3100/api/services/register');
      const body = JSON.parse(opts.body);
      expect(body).toEqual({ servicePath: '/svc/path', invokePort: 3010, region: 'sa-east-1' });
    });

    it('omits region when the provider has none', async () => {
      const sls = makeServerless({ service: { provider: {}, custom: {} } });
      const p = new Plugin(sls, {});
      await p.hooks['before:offline:start:init']();
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.region).toBeUndefined();
    });

    it('logs an error (non-blocking) on a non-ok response', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Server Error',
        json: async () => ({ error: 'boom' }),
      });
      const p = new Plugin(makeServerless(), {});
      await expect(p.hooks['after:package:finalize']()).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalled();
    });

    it('falls back to statusText when the error body cannot be parsed', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        json: async () => {
          throw new Error('not json');
        },
      });
      const p = new Plugin(makeServerless(), {});
      await expect(p.hooks['after:package:finalize']()).resolves.toBeUndefined();
    });

    it('logs an error (non-blocking) when fetch rejects', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
      const p = new Plugin(makeServerless(), {});
      await expect(p.hooks['after:package:finalize']()).resolves.toBeUndefined();
    });

    it('falls back to config.service when service.service is absent', async () => {
      const sls = makeServerless({ service: { service: undefined, custom: {}, provider: { region: 'eu-west-1' } } });
      const p = new Plugin(sls, {});
      await p.hooks['after:package:finalize']();
      expect(fetchMock).toHaveBeenCalled();
    });

    it("uses 'unknown' when neither service.service nor config.service is set", async () => {
      // service undefined + config.service undefined → serviceName falls back to 'unknown'.
      const p = new Plugin({ config: { servicePath: '/x' }, service: undefined } as any);
      await p.hooks['after:package:finalize']();
      expect(fetchMock).toHaveBeenCalled();
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.servicePath).toBe('/x');
      expect(body.region).toBeUndefined();
    });

    it('falls back to "HTTP <status>" when the error body has no error field', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 503, statusText: 'Unavailable', json: async () => ({}) });
      const p = new Plugin(makeServerless(), {});
      await expect(p.hooks['after:package:finalize']()).resolves.toBeUndefined();
    });
  });
});
