// The split that lets the REST API, the dashboard and the AWS wire share one
// port. Getting it wrong is not subtle: the engine's dispatcher falls back to
// S3 for anything it cannot classify, so a false positive turns
// `GET /assets/app.js` into a bucket read, and a false negative makes an SDK
// call render the SPA.
import { isAwsRequest, type AwsRequestProbe } from '../../../../src/server/engine/http/is-aws-request';

function probe(overrides: Partial<AwsRequestProbe> = {}): AwsRequestProbe {
  return {
    method: 'GET',
    path: '/',
    headers: {},
    query: new URLSearchParams(),
    ...overrides,
  };
}

describe('routes to the engine', () => {
  it('a signed request, whatever the protocol', () => {
    expect(isAwsRequest(probe({
      headers: { authorization: 'AWS4-HMAC-SHA256 Credential=test/20260731/us-east-1/s3/aws4_request' },
    }))).toBe(true);
  });

  it('a presigned URL — the scope is in the query, not a header', () => {
    expect(isAwsRequest(probe({
      query: new URLSearchParams({ 'X-Amz-Credential': 'test/20260731/us-east-1/s3/aws4_request' }),
    }))).toBe(true);
  });

  it('a JSON-protocol call named by X-Amz-Target', () => {
    expect(isAwsRequest(probe({
      method: 'POST',
      headers: { 'x-amz-target': 'DynamoDB_20120810.ListTables' },
    }))).toBe(true);
  });

  it('any other x-amz-* header (unsigned but AWS-shaped)', () => {
    expect(isAwsRequest(probe({ headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' } }))).toBe(true);
    expect(isAwsRequest(probe({ headers: { 'X-Amz-Date': '20260731T000000Z' } }))).toBe(true);
  });

  it('engine-owned paths', () => {
    for (const path of [
      '/_aoss',
      '/_aoss/products-catalog/_search',
      '/2015-03-31/functions/svc-dev-fn/invocations',
      '/_lss/health',
      '/_localstack/health',
    ]) {
      expect(isAwsRequest(probe({ path }))).toBe(true);
    }
  });

  it('a presigned POST form upload — the signature is a field, not a header', () => {
    expect(isAwsRequest(probe({
      method: 'POST',
      path: '/billing-receipts',
      headers: { 'content-type': 'multipart/form-data; boundary=----x' },
    }))).toBe(true);
  });

  it('a legacy Query-protocol call (aws-sdk v2 / old boto3)', () => {
    expect(isAwsRequest(probe({
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }))).toBe(true);
  });

  it('reads the first value of a repeated header', () => {
    expect(isAwsRequest(probe({
      headers: { authorization: ['AWS4-HMAC-SHA256 Credential=a/b/c/s3/aws4_request', 'other'] },
    }))).toBe(true);
  });
});

describe('routes to the orchestrator', () => {
  it('the dashboard SPA and its assets — never mistaken for a bucket', () => {
    expect(isAwsRequest(probe({ path: '/' }))).toBe(false);
    expect(isAwsRequest(probe({ path: '/assets/index-abc123.js' }))).toBe(false);
    expect(isAwsRequest(probe({ path: '/favicon.svg' }))).toBe(false);
    expect(isAwsRequest(probe({ path: '/services/orders-service' }))).toBe(false);
  });

  it('the REST API, including a JSON POST', () => {
    expect(isAwsRequest(probe({ path: '/api/health' }))).toBe(false);
    expect(isAwsRequest(probe({
      method: 'POST',
      path: '/api/services/register',
      headers: { 'content-type': 'application/json' },
    }))).toBe(false);
  });

  // The discriminator is header-based, so the SDK and the browser never fight
  // over a name.
  it('a bucket named like an API path is not a conflict', () => {
    expect(isAwsRequest(probe({ path: '/api/some-key' }))).toBe(false);
    expect(isAwsRequest(probe({
      path: '/api/some-key',
      headers: { authorization: 'AWS4-HMAC-SHA256 Credential=t/2/r/s3/aws4_request' },
    }))).toBe(true);
  });

  it('an unrelated Authorization scheme', () => {
    expect(isAwsRequest(probe({ headers: { authorization: 'Bearer abc123' } }))).toBe(false);
  });

  it('a path that merely starts like an engine path', () => {
    expect(isAwsRequest(probe({ path: '/_aossify' }))).toBe(true); // prefix match, by design
    expect(isAwsRequest(probe({ path: '/2015' }))).toBe(false);
  });

  it('a GET with a form content-type (only POST is claimed)', () => {
    expect(isAwsRequest(probe({ headers: { 'content-type': 'application/x-www-form-urlencoded' } }))).toBe(false);
    expect(isAwsRequest(probe({ headers: { 'content-type': 'multipart/form-data' } }))).toBe(false);
  });

  it('a missing header value', () => {
    expect(isAwsRequest(probe({ headers: { authorization: undefined, 'content-type': undefined } }))).toBe(false);
  });
});
