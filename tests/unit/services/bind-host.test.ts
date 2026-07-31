// Unit tests for the process-wide network posture (src/server/services/bind-host.ts).
//
// Both halves of the posture — the interface every listener binds
// (`LSS_BIND_HOST`) and the browser origins the REST API answers
// (`LSS_CORS_ORIGINS`) — are resolved ONCE at module load, on purpose: listeners
// come up at very different moments (boot, a service registration, a hot reload
// an hour later) and must not be able to disagree about how exposed the process
// is. So every case here sets the env, re-loads the module inside
// `jest.isolateModules()` and restores the env afterwards — the same shape
// config-manager.test.ts uses for its singleton.
//
// What the module is defending: this API has no authentication and runs commands
// on the host (start spawns a process, package runs a build command), and the
// per-service invoke ports execute a registered handler with the request body as
// its event. The bind decides which machines reach that; CORS decides which
// pages a browser lets read the answer.

type BindHost = typeof import('../../../src/server/services/bind-host');

const MODULE = '../../../src/server/services/bind-host';
const ENV = { ...process.env };

/**
 * Load a fresh copy of the module under the current environment. resetModules
 * (via isolateModules) is the only way to change the resolved posture, which is
 * the point: no request path can.
 */
function freshBindHost(env: Record<string, string | undefined>): BindHost {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  let loaded: BindHost | undefined;
  jest.isolateModules(() => {
    loaded = require(MODULE) as BindHost;
  });
  return loaded as BindHost;
}

beforeEach(() => {
  delete process.env.LSS_BIND_HOST;
  delete process.env.LSS_CORS_ORIGINS;
});

afterEach(() => {
  process.env = { ...ENV };
});

describe('getBindHost', () => {
  it('defaults to loopback so a fresh install is never on the network', () => {
    expect(freshBindHost({}).getBindHost()).toBe('127.0.0.1');
  });

  it('honours LSS_BIND_HOST, trims it, and treats a blank value as unset', () => {
    const cases: Array<[string | undefined, string]> = [
      ['0.0.0.0', '0.0.0.0'], // the documented opt-in (Docker port publishing)
      ['::', '::'],
      ['  10.0.0.5  ', '10.0.0.5'],
      ['   ', '127.0.0.1'], // whitespace is not an address
      ['', '127.0.0.1'],
    ];
    for (const [raw, expected] of cases) {
      expect(freshBindHost({ LSS_BIND_HOST: raw }).getBindHost()).toBe(expected);
    }
  });
});

describe('isLoopbackBind', () => {
  const { isLoopbackBind } = require(MODULE) as BindHost;

  it('accepts every spelling of "this machine only"', () => {
    // The whole 127.0.0.0/8 block is loopback, and ::ffff:127.x is that same
    // address seen through a dual-stack socket.
    for (const host of ['127.0.0.1', '127.0.0.53', 'localhost', 'LocalHost', '::1', '[::1]', '::ffff:127.0.0.1']) {
      expect(isLoopbackBind(host)).toBe(true);
    }
  });

  it('rejects the wildcards and routable addresses', () => {
    // `0.0.0.0` and `::` are exactly what the four listeners used to bind — a
    // bare `server.listen(port)` binds `::`, the dual-stack wildcard.
    for (const host of ['0.0.0.0', '::', '[::]', '192.168.1.10', '::ffff:192.168.1.10', 'lss.internal']) {
      expect(isLoopbackBind(host)).toBe(false);
    }
  });
});

describe('isOriginAllowed', () => {
  it('always allows a request with no Origin header', () => {
    // curl, the CLI, LssClient, the MCP server, an AWS SDK, the Vite proxy and
    // same-origin browser requests all arrive without one. Rejecting them would
    // break every non-browser caller LSS has, and none of them is the drive-by
    // this list defends against.
    for (const origins of [undefined, '', 'https://app.example.com', '*']) {
      const { isOriginAllowed } = freshBindHost({ LSS_CORS_ORIGINS: origins });
      expect(isOriginAllowed(undefined)).toBe(true);
      expect(isOriginAllowed('')).toBe(true);
    }
  });

  it('defaults to loopback origins on any port, http only', () => {
    const { isOriginAllowed } = freshBindHost({});
    // The Vite dev dashboard on :3101 calling :14566 is the real caller here;
    // the built dashboard is served by this process and never reaches CORS.
    for (const origin of ['http://localhost:3101', 'http://127.0.0.1:14566', 'http://[::1]', 'http://localhost']) {
      expect(isOriginAllowed(origin)).toBe(true);
    }
    for (const origin of ['https://localhost:3101', 'http://evil.com', 'http://localhost.evil.com', 'http://192.168.1.10:3000']) {
      expect(isOriginAllowed(origin)).toBe(false);
    }
  });

  it('treats a blank or whitespace-only LSS_CORS_ORIGINS as unset', () => {
    for (const raw of ['', '   ', ',  ,']) {
      const { isOriginAllowed } = freshBindHost({ LSS_CORS_ORIGINS: raw });
      expect(isOriginAllowed('http://localhost:3101')).toBe(true);
      expect(isOriginAllowed('http://192.168.1.10:5173')).toBe(false);
    }
  });

  it('allows exactly the configured origins, and nothing else', () => {
    // The operator's real layout: LSS in a container, the dashboard and their
    // own frontends opened from a browser outside it.
    const { isOriginAllowed } = freshBindHost({
      LSS_CORS_ORIGINS: 'http://192.168.1.10:14566, https://app.example.com',
    });
    expect(isOriginAllowed('http://192.168.1.10:14566')).toBe(true);
    expect(isOriginAllowed('https://app.example.com')).toBe(true);
    // An explicit list replaces the loopback default rather than adding to it —
    // and a near-miss is still a miss.
    expect(isOriginAllowed('http://app.example.com')).toBe(false);
    expect(isOriginAllowed('https://app.example.com:8443')).toBe(false);
    expect(isOriginAllowed('http://localhost:3101')).toBe(false);
  });

  it('normalises case and a trailing slash on both sides of the comparison', () => {
    // Browsers send `https://app.example.com`; an operator types
    // `https://App.Example.com/`. A silent non-match is the worst outcome for a
    // knob whose only job is to unblock a frontend.
    const { isOriginAllowed } = freshBindHost({ LSS_CORS_ORIGINS: 'https://App.Example.com/' });
    expect(isOriginAllowed('https://app.example.com')).toBe(true);
    expect(isOriginAllowed('HTTPS://APP.EXAMPLE.COM')).toBe(true);
  });

  it('allows any origin when the list is the wildcard', () => {
    const { isOriginAllowed } = freshBindHost({ LSS_CORS_ORIGINS: 'http://localhost:3101, *' });
    for (const origin of ['https://anything.example', 'http://192.168.1.10:5173', 'null']) {
      expect(isOriginAllowed(origin)).toBe(true);
    }
  });
});

describe('getExposureWarning', () => {
  it('is silent in the default posture — loopback bind, loopback-only CORS', () => {
    expect(freshBindHost({}).getExposureWarning()).toBeNull();
    // A non-wildcard allowlist is a deliberate, bounded choice: no warning.
    expect(
      freshBindHost({ LSS_BIND_HOST: '127.0.0.1', LSS_CORS_ORIGINS: 'https://app.example.com' })
        .getExposureWarning(),
    ).toBeNull();
  });

  it('names the bind when LSS_BIND_HOST leaves loopback', () => {
    const warning = freshBindHost({ LSS_BIND_HOST: '0.0.0.0' }).getExposureWarning();
    expect(warning).toContain('LSS_BIND_HOST=0.0.0.0');
    expect(warning).toContain('reachable from the network');
    expect(warning).toContain('no authentication');
    expect(warning).toContain('unset LSS_BIND_HOST to go back');
    expect(warning).not.toContain('LSS_CORS_ORIGINS');
  });

  it('names the wildcard CORS list even on a loopback bind', () => {
    const warning = freshBindHost({ LSS_CORS_ORIGINS: '*' }).getExposureWarning();
    expect(warning).toContain('LSS_CORS_ORIGINS=*');
    expect(warning).toContain('cross-origin');
    expect(warning).toContain('unset LSS_CORS_ORIGINS to go back');
    expect(warning).not.toContain('LSS_BIND_HOST');
  });

  it('reports both halves in one warning when both are widened', () => {
    // The operator who really did open everything sees a single line naming
    // both knobs — extending the warning, not printing a second one.
    const warning = freshBindHost({ LSS_BIND_HOST: '0.0.0.0', LSS_CORS_ORIGINS: '*' })
      .getExposureWarning() as string;
    expect(warning).toContain('LSS_BIND_HOST=0.0.0.0');
    expect(warning).toContain('LSS_CORS_ORIGINS=*');
    expect(warning).toContain('unset LSS_BIND_HOST and LSS_CORS_ORIGINS');
    expect(warning.split('⚠️').length - 1).toBe(1);
  });
});
