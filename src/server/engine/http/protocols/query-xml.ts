// Query-protocol (SNS/STS) and S3 rest-xml wire shapes: form-body parsing,
// success framing and the two XML error documents. QueryEmulators return the
// complete <XxxResponse> document themselves — this module only frames it.

import type { AwsResponse } from '../../types.js';
import type { AwsError } from '../errors.js';
import { tag, xmlDocument } from '../xml.js';

export function parseFormBody(body: Buffer): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(body.toString('utf8'))) {
    params[key] = value;
  }
  return params;
}

export function queryXmlSuccessResponse(xml: string): AwsResponse {
  return {
    status: 200,
    headers: { 'content-type': 'text/xml' },
    body: xml.startsWith('<?xml') ? xml : xmlDocument(xml),
  };
}

// <ErrorResponse><Error><Type/><Code/><Message/></Error><RequestId/></ErrorResponse>
export function queryErrorResponse(err: AwsError, requestId: string): AwsResponse {
  const xml = xmlDocument(
    tag(
      'ErrorResponse',
      tag('Error', tag('Type', err.fault) + tag('Code', err.code) + tag('Message', err.message), { escape: false }) +
        tag('RequestId', requestId),
      { escape: false },
    ),
  );
  return { status: err.status, headers: { 'content-type': 'text/xml' }, body: xml };
}

// S3: <Error><Code/><Message/><RequestId/></Error> — except HEAD, which must
// carry the status alone with an empty body (the SDK maps it from the status).
export function s3ErrorResponse(err: AwsError, requestId: string, method: string): AwsResponse {
  if (method === 'HEAD') return { status: err.status };
  const xml = xmlDocument(
    tag('Error', tag('Code', err.code) + tag('Message', err.message) + tag('RequestId', requestId), {
      escape: false,
    }),
  );
  return { status: err.status, headers: { 'content-type': 'application/xml' }, body: xml };
}
