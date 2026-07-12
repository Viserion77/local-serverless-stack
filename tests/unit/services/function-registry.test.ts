// Unit tests for FunctionRegistry: the in-memory function/route/authorizer
// lookup layer. Pure data structure — the only collaborator (CacheManager, for
// rehydrate) is a stub. The singleton instance is reset before every test so
// state never leaks across cases.
import { FunctionRegistry } from '../../../src/server/services/function-registry';
import type { CacheManager, ServiceMetadata } from '../../../src/server/services/cache-manager';
import type { RegisteredFunction } from '../../../src/server/services/serverless-state-parser';

function fn(name: string, fullName: string): RegisteredFunction {
  return {
    name,
    fullName,
    handler: `src/${name}.handler`,
    runtime: 'nodejs20.x',
    memorySize: 128,
    timeout: 6,
    environment: {},
    triggers: [],
  };
}

function meta(name: string, overrides: Partial<ServiceMetadata> = {}): ServiceMetadata {
  return {
    name,
    root: `/abs/${name}`,
    templateHash: 'h',
    lastUpdated: 1,
    status: 'registered',
    ...overrides,
  };
}

let registry: FunctionRegistry;

beforeEach(() => {
  (FunctionRegistry as any).instance = undefined;
  registry = FunctionRegistry.getInstance();
});

describe('getInstance', () => {
  it('returns the same instance on repeated calls (singleton)', () => {
    expect(FunctionRegistry.getInstance()).toBe(registry);
  });
});

describe('registerService / getService / listServices / removeService', () => {
  it('registers a service with all metadata fields', () => {
    const entry = registry.registerService(
      meta('svc-a', {
        region: 'us-east-1',
        stage: 'offline',
        apiPort: 3001,
        invokePort: 13001,
        functions: [fn('users', 'svc-a-offline-users')],
        routes: [{ functionName: 'users', method: 'GET', path: '/users', eventType: 'http', cors: false }],
        authorizers: [
          {
            name: 'auth',
            type: 'token',
            eventType: 'http',
            payloadVersion: '1.0',
            enableSimpleResponses: false,
            identitySource: [],
            resultTtlInSeconds: 300,
          },
        ],
      }),
    );
    expect(entry.name).toBe('svc-a');
    expect(entry.apiPort).toBe(3001);
    expect(registry.getService('svc-a')).toBe(entry);
    expect(registry.listServices()).toEqual([entry]);
  });

  it('defaults functions/routes/authorizers to empty arrays', () => {
    const entry = registry.registerService(meta('bare'));
    expect(entry.functions).toEqual([]);
    expect(entry.routes).toEqual([]);
    expect(entry.authorizers).toEqual([]);
  });

  it('re-registering replaces the previous entry', () => {
    registry.registerService(meta('svc-a', { functions: [fn('a', 'svc-a-dev-a')] }));
    registry.registerService(meta('svc-a', { functions: [] }));
    expect(registry.getService('svc-a')!.functions).toEqual([]);
    expect(registry.listServices()).toHaveLength(1);
  });

  it('removeService deletes the entry', () => {
    registry.registerService(meta('svc-a'));
    registry.removeService('svc-a');
    expect(registry.getService('svc-a')).toBeUndefined();
    expect(registry.listServices()).toEqual([]);
  });
});

describe('listFunctions', () => {
  it('flattens functions across services with their service entry', () => {
    registry.registerService(meta('svc-a', { functions: [fn('a1', 'svc-a-dev-a1'), fn('a2', 'svc-a-dev-a2')] }));
    registry.registerService(meta('svc-b', { functions: [fn('b1', 'svc-b-dev-b1')] }));
    const refs = registry.listFunctions();
    expect(refs.map(r => `${r.service.name}/${r.fn.name}`)).toEqual(['svc-a/a1', 'svc-a/a2', 'svc-b/b1']);
  });
});

describe('resolve', () => {
  beforeEach(() => {
    registry.registerService(meta('svc-a', { functions: [fn('users', 'svc-a-dev-users'), fn('unique', 'svc-a-dev-unique')] }));
    registry.registerService(meta('svc-b', { functions: [fn('users', 'svc-b-dev-users')] }));
  });

  it('returns undefined for an empty name', () => {
    expect(registry.resolve('')).toBeUndefined();
  });

  it('resolves a unique short name globally', () => {
    const ref = registry.resolve('unique')!;
    expect(ref.service.name).toBe('svc-a');
    expect(ref.fn.fullName).toBe('svc-a-dev-unique');
  });

  it('returns undefined for an ambiguous short name', () => {
    expect(registry.resolve('users')).toBeUndefined();
  });

  it('resolves a fully qualified name even when the short name is ambiguous', () => {
    expect(registry.resolve('svc-b-dev-users')!.service.name).toBe('svc-b');
  });

  it('resolves a Lambda ARN by extracting the function name', () => {
    const ref = registry.resolve('arn:aws:lambda:us-east-1:000000000000:function:svc-a-dev-users:$LATEST')!;
    expect(ref.fn.fullName).toBe('svc-a-dev-users');
  });

  it('scopes ambiguous short names with preferredService', () => {
    expect(registry.resolve('users', 'svc-b')!.service.name).toBe('svc-b');
    expect(registry.resolve('users', 'svc-a')!.service.name).toBe('svc-a');
  });

  it('preferredService also matches on the full name', () => {
    expect(registry.resolve('svc-a-dev-users', 'svc-a')!.fn.name).toBe('users');
  });

  it('falls back to the global search when preferredService is unknown', () => {
    expect(registry.resolve('unique', 'ghost-service')!.service.name).toBe('svc-a');
  });

  it('falls back to the global search when the function is not in preferredService', () => {
    expect(registry.resolve('unique', 'svc-b')!.service.name).toBe('svc-a');
  });

  it('returns undefined when nothing matches', () => {
    expect(registry.resolve('nope')).toBeUndefined();
    expect(registry.resolve('arn:aws:lambda:us-east-1:000000000000:function:ghost')).toBeUndefined();
  });
});

describe('port lookups', () => {
  beforeEach(() => {
    registry.registerService(meta('svc-a', { apiPort: 3001, invokePort: 13001 }));
    registry.registerService(meta('svc-b', { apiPort: 3002, invokePort: 13002 }));
  });

  it('getServiceByApiPort finds the owning service', () => {
    expect(registry.getServiceByApiPort(3002)!.name).toBe('svc-b');
    expect(registry.getServiceByApiPort(9999)).toBeUndefined();
  });

  it('getServiceByInvokePort finds the owning service', () => {
    expect(registry.getServiceByInvokePort(13001)!.name).toBe('svc-a');
    expect(registry.getServiceByInvokePort(9999)).toBeUndefined();
  });
});

describe('getAuthorizer', () => {
  it('finds an authorizer by service and name', () => {
    registry.registerService(
      meta('svc-a', {
        authorizers: [
          {
            name: 'main',
            type: 'request',
            eventType: 'httpApi',
            payloadVersion: '2.0',
            enableSimpleResponses: true,
            identitySource: ['$request.header.x'],
            resultTtlInSeconds: 0,
            functionName: 'auth',
          },
        ],
      }),
    );
    expect(registry.getAuthorizer('svc-a', 'main')!.functionName).toBe('auth');
    expect(registry.getAuthorizer('svc-a', 'ghost')).toBeUndefined();
    expect(registry.getAuthorizer('no-such-service', 'main')).toBeUndefined();
  });
});

describe('rehydrate', () => {
  it('registers every cached service and returns the entries', async () => {
    const cache = {
      listServices: jest.fn().mockResolvedValue([
        meta('svc-a', { functions: [fn('a', 'svc-a-dev-a')] }),
        meta('svc-b'),
      ]),
    } as unknown as CacheManager;

    const entries = await registry.rehydrate(cache);

    expect(cache.listServices).toHaveBeenCalledTimes(1);
    expect(entries.map(e => e.name)).toEqual(['svc-a', 'svc-b']);
    expect(registry.resolve('a')!.service.name).toBe('svc-a');
  });
});
