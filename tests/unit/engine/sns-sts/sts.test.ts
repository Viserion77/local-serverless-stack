// StsEmulator: GetCallerIdentity XML shape (PRD §RF2.5) and the explicit
// not-implemented wall for everything else.
import { StsEmulator } from '../../../../src/server/engine/emulators/sts';
import { EngineBus } from '../../../../src/server/engine/bus';
import { parseXml, childText, childrenNamed } from '../../../../src/server/engine/http/xml';
import type { AwsRequest, EngineContext } from '../../../../src/server/engine/types';
import type { EngineStore } from '../../../../src/server/engine/store/store-types';

function makeContext(): EngineContext {
  return {
    config: {
      port: 14566, dataDir: '/unused', account: '000000000000', region: 'us-east-1',
      idleUnloadMs: 60000, memoryBudgetMb: 128, fsync: false, fallbackEndpoint: null, persistence: true,
    },
    store: {} as EngineStore, // STS keeps no state
    bus: new EngineBus(),
    dispatcher: { invokeFunction: async () => ({ ok: true }) },
    endpoint: () => 'http://127.0.0.1:14566',
  };
}

function request(): AwsRequest {
  return {
    method: 'POST', rawPath: '/', query: {}, headers: {}, body: Buffer.alloc(0),
    service: 'sts', region: 'us-east-1', requestId: 'test-request',
  };
}

test('GetCallerIdentity returns the root-identity XML document', async () => {
  const emulator = new StsEmulator(makeContext());
  const xml = await emulator.handle('GetCallerIdentity', {}, request());
  const root = parseXml(xml);
  expect(root.name).toBe('GetCallerIdentityResponse');
  expect(root.attributes.xmlns).toBe('https://sts.amazonaws.com/doc/2011-06-15/');
  const result = childrenNamed(root, 'GetCallerIdentityResult')[0];
  expect(childText(result, 'Arn')).toBe('arn:aws:iam::000000000000:root');
  expect(childText(result, 'UserId')).toBe('000000000000');
  expect(childText(result, 'Account')).toBe('000000000000');
  const metadata = childrenNamed(root, 'ResponseMetadata')[0];
  expect(childText(metadata, 'RequestId')).toMatch(/^[0-9a-f-]{36}$/);
});

test('every other action throws NotImplemented', async () => {
  const emulator = new StsEmulator(makeContext());
  await expect(emulator.handle('AssumeRole', {}, request()))
    .rejects.toMatchObject({ code: 'NotImplemented' });
});
