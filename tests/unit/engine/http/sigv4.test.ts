import { parseCredentialScope, resolveSigV4Scope } from '../../../../src/server/engine/http/sigv4.js';

describe('parseCredentialScope', () => {
  it('parses a well-formed credential scope', () => {
    expect(parseCredentialScope('AKIDEXAMPLE/20260710/us-east-1/dynamodb/aws4_request')).toEqual({
      accessKeyId: 'AKIDEXAMPLE',
      date: '20260710',
      region: 'us-east-1',
      service: 'dynamodb',
    });
  });

  it('rejects scopes with the wrong number of segments', () => {
    expect(parseCredentialScope('AKID/20260710/us-east-1/aws4_request')).toBeUndefined();
    expect(parseCredentialScope('AKID/20260710/us-east-1/s3/extra/aws4_request')).toBeUndefined();
  });

  it('rejects scopes not terminated by aws4_request', () => {
    expect(parseCredentialScope('AKID/20260710/us-east-1/s3/aws4_request2')).toBeUndefined();
  });

  it('rejects scopes with an empty region or service', () => {
    expect(parseCredentialScope('AKID/20260710//s3/aws4_request')).toBeUndefined();
    expect(parseCredentialScope('AKID/20260710/us-east-1//aws4_request')).toBeUndefined();
  });
});

describe('resolveSigV4Scope', () => {
  const authorization =
    'AWS4-HMAC-SHA256 Credential=test/20260710/sa-east-1/sqs/aws4_request, ' +
    'SignedHeaders=content-type;host;x-amz-target, Signature=deadbeef';

  it('resolves from the Authorization header', () => {
    expect(resolveSigV4Scope({ authorization }, {})).toEqual({
      accessKeyId: 'test',
      date: '20260710',
      region: 'sa-east-1',
      service: 'sqs',
    });
  });

  it('resolves from the presigned X-Amz-Credential query param', () => {
    const scope = resolveSigV4Scope({}, { 'X-Amz-Credential': 'test/20260710/eu-west-1/s3/aws4_request' });
    expect(scope).toEqual({ accessKeyId: 'test', date: '20260710', region: 'eu-west-1', service: 's3' });
  });

  it('prefers the Authorization header over the presigned param', () => {
    const scope = resolveSigV4Scope(
      { authorization },
      { 'X-Amz-Credential': 'test/20260710/eu-west-1/s3/aws4_request' },
    );
    expect(scope?.service).toBe('sqs');
  });

  it('ignores non-SigV4 Authorization headers', () => {
    expect(resolveSigV4Scope({ authorization: 'Bearer abc123' }, {})).toBeUndefined();
  });

  it('falls back to the presigned param when the header scope is malformed', () => {
    const scope = resolveSigV4Scope(
      { authorization: 'AWS4-HMAC-SHA256 Credential=garbage, Signature=x' },
      { 'X-Amz-Credential': 'test/20260710/eu-west-1/s3/aws4_request' },
    );
    expect(scope?.service).toBe('s3');
  });

  it('returns undefined when nothing scope-shaped is present', () => {
    expect(resolveSigV4Scope({}, {})).toBeUndefined();
    expect(resolveSigV4Scope({ authorization: 'AWS4-HMAC-SHA256 SignedHeaders=host' }, {})).toBeUndefined();
  });
});
