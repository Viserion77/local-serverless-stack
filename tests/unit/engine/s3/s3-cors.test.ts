// S3 CORS: the piece that lets a browser actually read a presigned upload's
// response. Covers PutBucketCors/GetBucketCors/DeleteBucketCors round-trip,
// the preflight OPTIONS answer, Access-Control-Allow-Origin on real responses,
// configured-rule matching (origin/method/headers, wildcard origin, expose
// headers, max-age) and the dev-permissive fallback when no rule matches.
import { S3Emulator } from '../../../../src/server/engine/emulators/s3';
import {
  cleanupContext, makeContext, makeReq, expectAwsError, type TestContext,
} from './helpers';

const ORIGIN = 'http://localhost:4075';

function corsXml(rule: {
  origins: string[]; methods: string[]; headers?: string[]; expose?: string[]; maxAge?: number; id?: string;
}): string {
  const parts = [
    ...(rule.id ? [`<ID>${rule.id}</ID>`] : []),
    ...rule.origins.map(o => `<AllowedOrigin>${o}</AllowedOrigin>`),
    ...rule.methods.map(m => `<AllowedMethod>${m}</AllowedMethod>`),
    ...(rule.headers ?? []).map(h => `<AllowedHeader>${h}</AllowedHeader>`),
    ...(rule.expose ?? []).map(h => `<ExposeHeader>${h}</ExposeHeader>`),
    ...(rule.maxAge !== undefined ? [`<MaxAgeSeconds>${rule.maxAge}</MaxAgeSeconds>`] : []),
  ].join('');
  return `<CORSConfiguration><CORSRule>${parts}</CORSRule></CORSConfiguration>`;
}

describe('S3 CORS', () => {
  let context: TestContext;
  let s3: S3Emulator;

  beforeEach(async () => {
    context = makeContext();
    s3 = new S3Emulator(context.ctx);
    await s3.handle(makeReq('PUT', '/uploads'));
  });

  afterEach(() => cleanupContext(context));

  const putCors = (xml: string) =>
    s3.handle(makeReq('PUT', '/uploads', { query: { cors: '' }, body: xml }));
  const preflight = (headers: Record<string, string>) =>
    s3.handle(makeReq('OPTIONS', '/uploads', { headers }));

  describe('preflight OPTIONS', () => {
    it('is permissive by default (no CORS config): echoes origin, allows every method', async () => {
      const res = await preflight({ origin: ORIGIN, 'access-control-request-method': 'POST' });
      expect(res.status).toBe(200);
      expect(res.headers?.['Access-Control-Allow-Origin']).toBe(ORIGIN);
      expect(res.headers?.['Access-Control-Allow-Methods']).toContain('POST');
      expect(res.headers?.['Access-Control-Max-Age']).toBe('3600');
      expect(res.headers?.Vary).toBe('Origin');
    });

    it('echoes the requested headers in the permissive default', async () => {
      const res = await preflight({
        origin: ORIGIN,
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'content-type,x-amz-meta-owner',
      });
      expect(res.headers?.['Access-Control-Allow-Headers']).toBe('content-type,x-amz-meta-owner');
    });

    it('honors a matching bucket CORS rule (methods, expose, max-age)', async () => {
      await putCors(corsXml({
        origins: [ORIGIN], methods: ['GET', 'POST'], headers: ['*'], expose: ['ETag'], maxAge: 600,
      }));
      const res = await preflight({ origin: ORIGIN, 'access-control-request-method': 'POST' });
      expect(res.status).toBe(200);
      expect(res.headers?.['Access-Control-Allow-Origin']).toBe(ORIGIN);
      expect(res.headers?.['Access-Control-Allow-Methods']).toBe('GET, POST');
      expect(res.headers?.['Access-Control-Expose-Headers']).toBe('ETag');
      expect(res.headers?.['Access-Control-Max-Age']).toBe('600');
    });

    it('matches a wildcard AllowedOrigin', async () => {
      await putCors(corsXml({ origins: ['http://*.localhost:4075'], methods: ['POST'] }));
      const res = await preflight({ origin: 'http://app.localhost:4075', 'access-control-request-method': 'POST' });
      expect(res.headers?.['Access-Control-Allow-Methods']).toBe('POST');
    });

    it('falls back to permissive when a configured rule does not match the method', async () => {
      await putCors(corsXml({ origins: [ORIGIN], methods: ['GET'], maxAge: 600 }));
      // Requested method POST is not in the rule → dev-permissive default wins.
      const res = await preflight({ origin: ORIGIN, 'access-control-request-method': 'POST' });
      expect(res.headers?.['Access-Control-Allow-Methods']).toBe('GET, PUT, POST, DELETE, HEAD');
      expect(res.headers?.['Access-Control-Max-Age']).toBe('3600');
    });

    it('rejects a preflight whose requested header is outside a restrictive rule', async () => {
      await putCors(corsXml({ origins: [ORIGIN], methods: ['PUT'], headers: ['content-type'] }));
      // x-custom is not allowed → no rule matches → permissive fallback (dev).
      const res = await preflight({
        origin: ORIGIN, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'x-custom',
      });
      expect(res.headers?.['Access-Control-Allow-Methods']).toBe('GET, PUT, POST, DELETE, HEAD');
    });
  });

  describe('Access-Control-Allow-Origin on real responses', () => {
    it('stamps the presigned POST response so the browser can read it', async () => {
      const boundary = 'B';
      const body = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="key"\r\n\r\nfile.txt\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="file.txt"\r\n\r\nhi\r\n` +
        `--${boundary}--\r\n`,
      );
      const res = await s3.handle(makeReq('POST', '/uploads', {
        headers: { origin: ORIGIN, 'content-type': `multipart/form-data; boundary=${boundary}` },
        body,
      }));
      expect(res.status).toBe(204);
      expect(res.headers?.['Access-Control-Allow-Origin']).toBe(ORIGIN);
      expect(res.headers?.['Access-Control-Expose-Headers']).toContain('ETag');
    });

    it('stamps a GET response', async () => {
      await s3.handle(makeReq('PUT', '/uploads/a.txt', { body: 'data' }));
      const res = await s3.handle(makeReq('GET', '/uploads/a.txt', { headers: { origin: ORIGIN } }));
      expect(res.status).toBe(200);
      expect(res.headers?.['Access-Control-Allow-Origin']).toBe(ORIGIN);
    });

    it('adds no CORS headers when the request carries no Origin', async () => {
      await s3.handle(makeReq('PUT', '/uploads/a.txt', { body: 'data' }));
      const res = await s3.handle(makeReq('GET', '/uploads/a.txt'));
      expect(res.headers?.['Access-Control-Allow-Origin']).toBeUndefined();
    });

    it('honors the configured expose headers on a real response', async () => {
      await putCors(corsXml({ origins: [ORIGIN], methods: ['GET'], expose: ['ETag', 'x-amz-meta-owner'] }));
      await s3.handle(makeReq('PUT', '/uploads/a.txt', { body: 'data' }));
      const res = await s3.handle(makeReq('GET', '/uploads/a.txt', { headers: { origin: ORIGIN } }));
      expect(res.headers?.['Access-Control-Expose-Headers']).toBe('ETag, x-amz-meta-owner');
    });
  });

  describe('PutBucketCors / GetBucketCors / DeleteBucketCors', () => {
    it('round-trips the configuration', async () => {
      const put = await putCors(corsXml({
        id: 'rule-1', origins: [ORIGIN, 'https://*.example.com'], methods: ['GET', 'PUT', 'POST'],
        headers: ['*'], expose: ['ETag'], maxAge: 3000,
      }));
      expect(put.status).toBe(200);

      const get = await s3.handle(makeReq('GET', '/uploads', { query: { cors: '' } }));
      expect(get.status).toBe(200);
      const xml = get.body?.toString() ?? '';
      expect(xml).toContain('<ID>rule-1</ID>');
      expect(xml).toContain('<AllowedOrigin>http://localhost:4075</AllowedOrigin>');
      expect(xml).toContain('<AllowedOrigin>https://*.example.com</AllowedOrigin>');
      expect(xml).toContain('<AllowedMethod>POST</AllowedMethod>');
      expect(xml).toContain('<ExposeHeader>ETag</ExposeHeader>');
      expect(xml).toContain('<MaxAgeSeconds>3000</MaxAgeSeconds>');
    });

    it('returns NoSuchCORSConfiguration when none is set', async () => {
      await expectAwsError(
        s3.handle(makeReq('GET', '/uploads', { query: { cors: '' } })),
        'NoSuchCORSConfiguration',
        404,
      );
    });

    it('deletes the configuration', async () => {
      await putCors(corsXml({ origins: [ORIGIN], methods: ['GET'] }));
      const del = await s3.handle(makeReq('DELETE', '/uploads', { query: { cors: '' } }));
      expect(del.status).toBe(204);
      await expectAwsError(
        s3.handle(makeReq('GET', '/uploads', { query: { cors: '' } })),
        'NoSuchCORSConfiguration',
        404,
      );
    });

    it('fails PutBucketCors on a missing bucket', async () => {
      await expectAwsError(
        s3.handle(makeReq('PUT', '/ghost', { query: { cors: '' }, body: corsXml({ origins: ['*'], methods: ['GET'] }) })),
        'NoSuchBucket',
        404,
      );
    });
  });
});
