// web-function-assembler.ts + web-function-ports.ts: folding the three
// resource types into RegisteredWebFunctions (code resolution order, warnings),
// the weighted / pinned revision pick, stable port allocation and the
// https → http rewrite of web-function URLs in env values.
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { CloudFormationParser, webRevisionId, type Resource } from '../../../src/server/services/cloudformation-parser';
import {
  assembleWebFunctions,
  pickRevision,
  type RegisteredWebFunction,
  type WebAssembleInput,
} from '../../../src/server/services/web-function-assembler';
import {
  allocateWebPorts,
  assignedPorts,
  endpointKey,
  probePortFree,
  rewriteWebHttps,
} from '../../../src/server/services/web-function-ports';

const template = JSON.parse(fs.readFileSync(path.join(__dirname, '../../fixtures/web-functions-template.json'), 'utf-8'));
const state = JSON.parse(fs.readFileSync(path.join(__dirname, '../../fixtures/web-functions-state.json'), 'utf-8'));
const ROOT = '/repo/orders-service';
const resources = new CloudFormationParser().parse(template, [], { region: 'us-east-1' });
const STABLE = webRevisionId('OrdersWebStable', 'builds/orders-web.zip');
const CANARY = webRevisionId('OrdersWebCanary', 'builds/orders-web-canary.zip');

function assemble(over: Partial<WebAssembleInput> = {}): { fns: RegisteredWebFunction[]; warnings: string[] } {
  const warnings: string[] = [];
  const fns = assembleWebFunctions({
    service: 'orders-service',
    root: ROOT,
    region: 'us-east-1',
    resources,
    executionMode: 'auto',
    warnings,
    exists: () => true,
    listZips: () => [],
    ...over,
  });
  return { fns, warnings };
}

describe('assembleWebFunctions', () => {
  it('folds function, revisions and endpoint into one entry', () => {
    const { fns, warnings } = assemble();
    expect(fns).toHaveLength(1);
    const [fn] = fns;
    expect(fn).toMatchObject({
      service: 'orders-service',
      name: 'orders-web',
      logicalId: 'OrdersWeb',
      arn: 'arn:aws:lambda:us-east-1:000000000000:web-function/orders-web',
      warnings: [],
    });
    expect(fn.revisions.map(r => r.revisionId)).toEqual([STABLE, CANARY]);
    expect(fn.revisions[0]).toMatchObject({
      timeoutSeconds: 10,
      maxConcurrency: 8,
      description: 'stable',
      // Only the literal values — Ref OrdersTable resolves at registration.
      environment: { AWS_LAMBDA_NODEJS_ENTRYPOINT: 'app.js', RELEASE: 'stable' },
      code: { source: 'source', root: ROOT, entry: 'app.js', reason: 'service source, AWS_LAMBDA_NODEJS_ENTRYPOINT=app.js' },
    });
    expect(fn.revisions[1]).not.toHaveProperty('description');
    expect(fn.revisions[1].code).toMatchObject({ source: 'source', entry: 'index.js', reason: 'service source, default index.js' });
    expect(fn.endpoints).toEqual([{
      logicalId: 'OrdersWebLive',
      name: 'live',
      arn: 'arn:aws:lambda:us-east-1:000000000000:web-function/orders-web/endpoint/live',
      authType: 'IamAuth',
      endpointType: 'HomeRegion',
      weights: [{ revisionId: STABLE, weight: 90 }, { revisionId: CANARY, weight: 10 }],
    }]);
    expect(warnings).toEqual([]);
  });

  it('takes the webApps entry first, then a matching zip, then the source', () => {
    const zips = [`${ROOT}/.serverless/orders-web.zip`];
    // 1. serverless-state webApps entry (Framework v4); the unmatched app is reported.
    const fromState = assemble({ stateWebApps: state.service.webApps, listZips: () => zips });
    expect(fromState.fns[0].revisions[0].code).toMatchObject({ source: 'state-entry', entry: 'src/web/server.js' });
    expect(fromState.warnings).toEqual([expect.stringContaining('webApps.reports-web')]);
    // 2. the S3Object.Key basename among .serverless/*.zip.
    const artifact = assemble({ listZips: () => zips }).fns[0].revisions;
    expect(artifact[0].code).toMatchObject({ source: 'artifact', artifact: zips[0], entry: 'app.js' });
    expect(artifact[1].code.source).toBe('source');
    // `source` mode never takes the zip; `artifact` mode takes nothing else.
    expect(assemble({ executionMode: 'source', listZips: () => zips }).fns[0].revisions[0].code.source).toBe('source');
    const strict = assemble({ executionMode: 'artifact', stateWebApps: state.service.webApps, listZips: () => zips });
    expect(strict.fns[0].revisions[0].code.source).toBe('artifact');
    expect(strict.fns[0].revisions[1].code).toMatchObject({ source: 'missing', reason: expect.stringContaining('artifact') });
    expect(strict.fns[0].warnings).toEqual([expect.stringContaining('no code to run')]);
    const keyless = resources.map(r => (r.type === 'web-function-revision' ? { ...r, codeKey: undefined } : r));
    expect(assemble({ resources: keyless, executionMode: 'artifact' }).fns[0].revisions[0].code.reason).toContain('S3Object.Key null');
  });

  it('reports a missing entry file, with or without AWS_LAMBDA_NODEJS_ENTRYPOINT', () => {
    const { fns } = assemble({ exists: () => false });
    expect(fns[0].revisions[0].code).toMatchObject({ source: 'missing', reason: expect.stringContaining('(AWS_LAMBDA_NODEJS_ENTRYPOINT)') });
    expect(fns[0].revisions[1].code.reason).toContain('set AWS_LAMBDA_NODEJS_ENTRYPOINT');
  });

  it('uses the real filesystem by default', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lss-web-asm-'));
    fs.mkdirSync(path.join(dir, '.serverless'));
    fs.writeFileSync(path.join(dir, '.serverless', 'orders-web.zip'), '');
    fs.writeFileSync(path.join(dir, 'index.js'), '');
    const warnings: string[] = [];
    const [fn] = assembleWebFunctions({ service: 's', root: dir, region: 'us-east-1', resources, executionMode: 'auto', warnings });
    expect(fn.revisions.map(r => r.code.source)).toEqual(['artifact', 'source']);
    const none = assembleWebFunctions({ service: 's', root: path.join(dir, 'nope'), region: 'us-east-1', resources, executionMode: 'auto', warnings });
    expect(none[0].revisions.map(r => r.code.source)).toEqual(['missing', 'missing']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('warns about everything AWS would reject or LSS serves differently', () => {
    const extra: Resource[] = [
      { type: 'web-function', logicalId: 'Other', name: 'other-web', tags: {} },
      { type: 'web-function', logicalId: 'Lonely', name: 'lonely-web', tags: {} },
      {
        type: 'web-function-revision', logicalId: 'OtherRev', name: 'OtherRev', functionRef: 'arn:aws:lambda:us-east-1:0:web-function/other-web',
        revisionId: 'r-other', runtime: 'nodejs20.x', environment: { AWS_REGION: 'x', AWS_LAMBDA_HTTP_ENDPOINT: 'y', N: 1 }, timeoutSeconds: 30, maxConcurrency: 64,
      },
      {
        type: 'web-function-revision', logicalId: 'OtherRev2', name: 'OtherRev2', functionRef: 'Other',
        revisionId: 'r-other-2', runtime: 'nodejs24.x', environment: { AWS_REGION: 'x', OBJ: { Ref: 'T' } }, timeoutSeconds: 30, maxConcurrency: 64,
      },
      {
        type: 'web-function-endpoint', logicalId: 'OtherEp', name: 'beta', functionRef: 'Other', endpointType: 'MultiRegion', authType: 'Bogus',
        revisionWeights: [
          { revisionRef: 'OtherRev', weight: 30 }, { revisionRef: 'r-other-2', weight: 30 },
          { revisionRef: 'OrdersWebStable', weight: 10 }, { revisionRef: 'Ghost', weight: 5 }, { revisionRef: 'OtherRev', weight: 1 },
        ],
      },
      { type: 'web-function-revision', logicalId: 'Dangling', name: 'Dangling', functionRef: 'nobody', revisionId: 'r-d', runtime: 'nodejs24.x', environment: {}, timeoutSeconds: 30, maxConcurrency: 64 },
      { type: 'web-function-endpoint', logicalId: 'DanglingEp', name: 'x', functionRef: 'nobody', endpointType: 'HomeRegion', authType: 'ApplicationManaged', revisionWeights: [] },
    ];
    const { fns, warnings } = assemble({ resources: [...resources, ...extra] });
    const other = fns.find(f => f.name === 'other-web') as RegisteredWebFunction;
    expect(other.revisions[0].environment).toEqual({ AWS_REGION: 'x', AWS_LAMBDA_HTTP_ENDPOINT: 'y', N: '1' });
    expect(other.endpoints[0]).toMatchObject({ authType: 'ApplicationManaged', weights: [{ revisionId: 'r-other', weight: 30 }, { revisionId: 'r-other-2', weight: 30 }, { revisionId: 'r-other', weight: 1 }] });
    const text = other.warnings.join('\n');
    expect(text).toMatch(/runtime "nodejs20.x"/);
    expect(text).toMatch(/AWS_REGION, AWS_LAMBDA_HTTP_ENDPOINT are names/);
    expect(text).toMatch(/AWS_REGION is a name/);
    expect(text).toMatch(/belongs to another web function/);
    expect(text).toMatch(/"Ghost"/);
    expect(text).toMatch(/at most 2 revisions; 3/);
    expect(text).toMatch(/sum to 61/);
    expect(text).toMatch(/MultiRegion/);
    expect(text).toMatch(/AuthType "Bogus"/);
    const lonely = fns.find(f => f.name === 'lonely-web') as RegisteredWebFunction;
    expect(lonely.warnings).toEqual([
      expect.stringContaining('no AWS::Lambda::WebFunctionRevision'),
      expect.stringContaining('no AWS::Lambda::WebFunctionEndpoint'),
    ]);
    expect(warnings.some(w => w.startsWith('[web function other-web]'))).toBe(true);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('WebFunctionRevision "Dangling"'),
      expect.stringContaining('WebFunctionEndpoint "DanglingEp"'),
    ]));
  });

  it('matches a webApps key by `-<name>` suffix and ignores an entry without one', () => {
    const named = resources.map(r => (r.type === 'web-function' ? { ...r, name: 'orders-service-dev-web' } : r));
    const fixed = named.map(r => (r.type === 'web-function-revision' ? { ...r, functionRef: 'OrdersWeb' } : r));
    const { fns, warnings } = assemble({ resources: fixed, stateWebApps: { other: undefined, 'dev-web': undefined, web: { entry: 'srv.js' }, 'orders-service-dev-web': {} } });
    expect(fns[0].revisions[0].code).toMatchObject({ source: 'state-entry', entry: 'srv.js' });
    expect(warnings).toEqual([expect.stringContaining('webApps.other')]);
  });
});

describe('pickRevision', () => {
  const [fn] = assemble().fns;
  const endpoint = fn.endpoints[0];

  it('honours a pin by revision id or logical id, and refuses an unknown one', () => {
    expect(pickRevision(fn, endpoint, CANARY)?.revisionId).toBe(CANARY);
    expect(pickRevision(fn, endpoint, 'OrdersWebStable')?.revisionId).toBe(STABLE);
    expect(pickRevision(fn, endpoint, 'nope')).toBeUndefined();
  });

  it('splits by weight', () => {
    expect(pickRevision(fn, endpoint, undefined, () => 0.5)?.revisionId).toBe(STABLE);
    expect(pickRevision(fn, endpoint, undefined, () => 0.95)?.revisionId).toBe(CANARY);
    // The upper edge of the roll lands on the last weighted revision.
    expect(pickRevision(fn, endpoint, undefined, () => 1)?.revisionId).toBe(CANARY);
    expect(pickRevision(fn, endpoint, undefined)).toBeDefined();
  });

  it('falls back to the newest revision without usable weights, or nothing at all', () => {
    expect(pickRevision(fn, { ...endpoint, weights: [{ revisionId: STABLE, weight: 0 }, { revisionId: 'gone', weight: 50 }] }, undefined)?.revisionId).toBe(CANARY);
    expect(pickRevision({ ...fn, revisions: [] }, { ...endpoint, weights: [] }, undefined)).toBeUndefined();
  });
});

describe('web function ports', () => {
  function fresh(): RegisteredWebFunction[] {
    const fns = assemble().fns;
    fns[0].endpoints.push({ ...fns[0].endpoints[0], logicalId: 'Beta', name: 'beta' });
    fns[0].endpoints.push({ ...fns[0].endpoints[0], logicalId: 'Gamma', name: 'gamma' });
    return fns;
  }

  it('keeps pinned and remembered ports, fills the rest from the range, skipping taken and busy ports', async () => {
    const fns = fresh();
    const warnings: string[] = [];
    const ports = await allocateWebPorts({
      functions: fns,
      pinned: (_fn, ep) => (ep === 'live' ? 15900 : undefined),
      previous: new Map([[endpointKey('orders-web', 'beta'), 15003]]),
      taken: new Set([15000]),
      range: [15000, 15010],
      warnings,
      isFree: async port => port !== 15001,
    });
    expect(Object.fromEntries(ports)).toEqual({ OrdersWebLive: 15900, Beta: 15003, Gamma: 15002 });
    expect(assignedPorts(fns)).toEqual(new Map([['orders-web/live', 15900], ['orders-web/beta', 15003], ['orders-web/gamma', 15002]]));
    expect(warnings).toEqual([]);
  });

  it('warns on a contended pinned port and on an exhausted range', async () => {
    const fns = fresh();
    const warnings: string[] = [];
    const ports = await allocateWebPorts({
      functions: fns,
      pinned: (_fn, ep) => (ep === 'live' ? 15000 : undefined),
      previous: new Map(),
      taken: new Set([15000]),
      range: [15001, 15001],
      warnings,
      isFree: async () => true,
    });
    expect(Object.fromEntries(ports)).toEqual({ OrdersWebLive: 15000, Beta: 15001 });
    expect(fns[0].endpoints[2].port).toBeUndefined();
    expect(warnings).toEqual([expect.stringContaining('both will contend'), expect.stringContaining('no free port left')]);
  });

  it('probes a real port', async () => {
    const server = net.createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    expect(await probePortFree(port, '127.0.0.1')).toBe(false);
    await new Promise<void>(resolve => server.close(() => resolve()));
    expect(await probePortFree(port)).toBe(true);
    // Default isFree is the real probe.
    const fns = assemble().fns;
    await allocateWebPorts({ functions: fns, pinned: () => undefined, previous: new Map(), taken: new Set(), range: [port, port], warnings: [] });
    expect(fns[0].endpoints[0].port).toBe(port);
    expect(assignedPorts(undefined).size).toBe(0);
  });

  it('rewrites https URLs of web ports only', () => {
    const env = {
      A: 'https://localhost:15000/x',
      B: 'https://127.0.0.1:15000',
      C: 'https://localhost:443',
      D: 'https://example.com',
    };
    expect(rewriteWebHttps(env, new Set([15000]))).toEqual({
      A: 'http://localhost:15000/x', B: 'http://127.0.0.1:15000', C: 'https://localhost:443', D: 'https://example.com',
    });
    expect(rewriteWebHttps(env, new Set())).toBe(env);
  });
});
