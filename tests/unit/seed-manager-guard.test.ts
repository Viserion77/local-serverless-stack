import { SeedManager } from '../../src/server/services/seed-manager';
import { EngineManager } from '../../src/server/engine/engine-manager';

// These tests cover the defensive guard added to SeedManager that refuses
// destructive operations (clearTable / clearAllSeeded) when the LocalStack
// endpoint resolves to anything other than a recognized local host. The
// architecture already pins the DynamoDBClient to LocalStack, but this guard
// is the safety net that ensures a future refactor can't accidentally point
// a clear at AWS.

describe('SeedManager — assertLocalEndpoint guard', () => {
  let endpointSpy: jest.SpyInstance;
  // Cast to any so we can reach the private guard directly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let seedManager: any;

  beforeAll(() => {
    seedManager = SeedManager.getInstance();
    // Touch the singleton so jest.spyOn can patch the instance method.
    EngineManager.getInstance();
  });

  beforeEach(() => {
    endpointSpy = jest.spyOn(EngineManager.getInstance(), 'getEndpoint');
  });

  afterEach(() => {
    endpointSpy.mockRestore();
  });

  describe('allows local hostnames', () => {
    const allowed = [
      'http://localhost:4566',
      'http://localhost:4567',
      'http://127.0.0.1:4566',
      'http://[::1]:4566',
      'http://0.0.0.0:4566',
      'http://host.docker.internal:4566',
      'http://localstack:4566',
      'http://lss-localstack:4566',
      'http://lss-localstack-4567:4566',
      'http://api.localhost:4566',
      'https://LOCALHOST:4566',
    ];

    it.each(allowed)('accepts %s', endpoint => {
      endpointSpy.mockReturnValue(endpoint);
      expect(() => seedManager.assertLocalEndpoint()).not.toThrow();
    });
  });

  describe('rejects non-local hostnames', () => {
    const rejected = [
      'https://dynamodb.us-east-1.amazonaws.com',
      'https://dynamodb.eu-west-1.amazonaws.com',
      'https://dynamodb.sa-east-1.amazonaws.com:443',
      'http://10.0.0.5:8000',
      'http://192.168.1.50:4566',
      'http://172.16.0.1:4566',
      'http://evil.com:4566',
      'http://example.com',
      'http://amazonaws.com',
      'http://localhost.evil.com:4566',
    ];

    it.each(rejected)('refuses %s', endpoint => {
      endpointSpy.mockReturnValue(endpoint);
      expect(() => seedManager.assertLocalEndpoint()).toThrow(
        /Refusing destructive operation/,
      );
    });

    it('mentions the offending endpoint and AWS warning in the error message', () => {
      endpointSpy.mockReturnValue('https://dynamodb.us-east-1.amazonaws.com');
      expect(() => seedManager.assertLocalEndpoint()).toThrow(
        /dynamodb\.us-east-1\.amazonaws\.com/,
      );
      expect(() => seedManager.assertLocalEndpoint()).toThrow(/never against AWS/i);
    });
  });

  describe('rejects malformed endpoints', () => {
    it('refuses an empty endpoint', () => {
      endpointSpy.mockReturnValue('');
      expect(() => seedManager.assertLocalEndpoint()).toThrow(
        /invalid LocalStack endpoint/,
      );
    });

    it('refuses a non-URL string', () => {
      endpointSpy.mockReturnValue('not a url at all');
      expect(() => seedManager.assertLocalEndpoint()).toThrow(
        /invalid LocalStack endpoint/,
      );
    });
  });
});

describe('SeedManager — clear methods invoke the guard', () => {
  let endpointSpy: jest.SpyInstance;
  let seedManager: SeedManager;

  beforeAll(() => {
    seedManager = SeedManager.getInstance();
    EngineManager.getInstance();
  });

  beforeEach(() => {
    endpointSpy = jest.spyOn(EngineManager.getInstance(), 'getEndpoint');
  });

  afterEach(() => {
    endpointSpy.mockRestore();
  });

  it('clearTable refuses to run against an AWS endpoint', async () => {
    endpointSpy.mockReturnValue('https://dynamodb.us-east-1.amazonaws.com');
    await expect(seedManager.clearTable('AnyTable')).rejects.toThrow(
      /Refusing destructive operation/,
    );
  });

  it('clearAllSeeded refuses to run against an AWS endpoint', async () => {
    endpointSpy.mockReturnValue('https://dynamodb.eu-west-1.amazonaws.com');
    await expect(seedManager.clearAllSeeded()).rejects.toThrow(
      /Refusing destructive operation/,
    );
  });

  it('clearTable does not throw the guard error when endpoint is localhost', async () => {
    endpointSpy.mockReturnValue('http://localhost:65535'); // unused port
    // The guard passes; the call still fails downstream (no DDB on this port),
    // but the failure must not be the guard error.
    try {
      await seedManager.clearTable('AnyTable');
    } catch (err) {
      expect((err as Error).message).not.toMatch(/Refusing destructive operation/);
    }
  });
});
