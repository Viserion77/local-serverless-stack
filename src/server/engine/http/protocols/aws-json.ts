// AWS JSON 1.0/1.1 protocol serialization (DynamoDB, SQS, EventBridge) plus
// the Lambda rest-json error shape. Success payloads come straight from the
// TargetEmulator; this module owns the wire framing and the error contracts
// the LSS provisioner branches on (docs/PRD_SELF_ENGINE.md §RF2.3/RF2.4).

import type { AwsResponse, EngineServiceName } from '../../types.js';
import type { AwsError } from '../errors.js';

export type JsonVersion = '1.0' | '1.1';

export function jsonContentType(version: JsonVersion): string {
  return `application/x-amz-json-${version}`;
}

export function jsonSuccessResponse(payload: object, version: JsonVersion): AwsResponse {
  return {
    status: 200,
    headers: { 'content-type': jsonContentType(version) },
    body: JSON.stringify(payload),
  };
}

// JSON error: {"__type": "<namespaced type or code>", "message": "..."} plus
// any extra top-level fields (e.g. DynamoDB CancellationReasons). For SQS the
// x-amzn-query-error header carries the legacy Query error code — the SDK's
// awsQueryCompatible trait rewrites err.name from it, and the provisioner's
// idempotency matches those legacy names.
export function jsonErrorResponse(
  err: AwsError,
  service: EngineServiceName | undefined,
  version: JsonVersion,
): AwsResponse {
  const headers: Record<string, string> = { 'content-type': jsonContentType(version) };
  if (service === 'sqs') headers['x-amzn-query-error'] = `${err.code};${err.fault}`;
  return {
    status: err.status,
    headers,
    body: JSON.stringify({ ...err.extra, __type: err.typeName ?? err.code, message: err.message }),
  };
}

// Lambda rest-json error: {"Type": "User"|"Service", "message": "..."} with
// the error code in x-amzn-ErrorType.
export function lambdaErrorResponse(err: AwsError): AwsResponse {
  return {
    status: err.status,
    headers: {
      'content-type': 'application/json',
      'x-amzn-ErrorType': err.code,
    },
    body: JSON.stringify({ Type: err.fault === 'Receiver' ? 'Service' : 'User', message: err.message }),
  };
}
