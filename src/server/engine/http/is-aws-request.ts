// Tells an AWS SDK call apart from a dashboard/API call, so both can share one
// listener.
//
// The orchestrator (REST API + SPA) and the engine (AWS wire) answer on the same
// port by default. That is only safe because the two traffic shapes are
// distinguishable *before* any routing: the engine's own dispatcher falls back
// to S3 for anything it cannot classify — `GET /assets/index.js` would be read
// as bucket `assets`, key `index.js` — so the split has to happen in front of it.
//
// The test is deliberately one-directional: it looks only for POSITIVE evidence
// of an AWS client. A browser fetching /api/health or /assets/app.js carries
// none of these, so it falls through to Express. That also means a bucket named
// `api` is not a conflict — the SDK signs its request, the browser does not.

import { RESET_PATH } from './reset.js';

export interface AwsRequestProbe {
  method: string;
  // Path only, without the query string.
  path: string;
  headers: Record<string, string | string[] | undefined>;
  // Parsed query parameters.
  query: URLSearchParams;
}

// Paths the engine owns outright: no AWS client signs a health probe or a
// reset, and the Lambda Invoke API / OpenSearch data plane are reached by
// plain HTTP too.
const ENGINE_PATH_PREFIXES = ['/_aoss', '/2015-03-31/', '/_lss/health', RESET_PATH, '/_localstack/health'];

// A Query-protocol operation name: PascalCase, as every AWS Action is.
const QUERY_ACTION = /^[A-Z][A-Za-z0-9]*$/;

export function isAwsRequest(probe: AwsRequestProbe): boolean {
  const header = (name: string): string => {
    const value = probe.headers[name];
    return (Array.isArray(value) ? value[0] : value) ?? '';
  };

  // 1. A signed request — every AWS SDK call, whichever protocol.
  if (header('authorization').startsWith('AWS4-HMAC-SHA256')) return true;

  // 2. A presigned URL carries the credential scope in the query instead.
  if (probe.query.has('X-Amz-Credential')) return true;

  // 2b. Query protocol with its parameters in the query string
  //     (`GET /?Action=ListTopics&Version=2010-03-31`) — valid AWS, and an
  //     unsigned one (curl, a health script) used to get the dashboard HTML.
  //     The orchestrator never reads a PascalCase `Action` parameter.
  if (QUERY_ACTION.test(probe.query.get('Action') ?? '')) return true;

  // 3. JSON protocols name their operation in a header (DynamoDB, SQS, SNS…).
  if (header('x-amz-target')) return true;

  // 4. Any other x-amz-* header: unsigned-but-AWS-shaped calls still send
  //    x-amz-content-sha256 / x-amz-date / x-amz-acl and friends.
  for (const name of Object.keys(probe.headers)) {
    if (name.toLowerCase().startsWith('x-amz-')) return true;
  }

  // 5. Engine-owned paths.
  if (ENGINE_PATH_PREFIXES.some(prefix => probe.path === prefix || probe.path.startsWith(prefix))) {
    return true;
  }

  const contentType = header('content-type').toLowerCase();

  // 6. Presigned POST: a browser form upload to `POST /<bucket>`. The signature
  //    travels as a FORM FIELD, not a header, so there is no x-amz-* to find.
  //    Safe to claim: the orchestrator API never accepts multipart.
  if (probe.method === 'POST' && contentType.includes('multipart/form-data')) return true;

  // 7. Legacy Query protocol (aws-sdk v2 / old boto3) posts form-encoded bodies.
  //    The orchestrator API is JSON-only, so this is unambiguous too.
  if (probe.method === 'POST' && contentType.includes('x-www-form-urlencoded')) return true;

  return false;
}
