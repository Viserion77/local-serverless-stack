// AWS-shaped error for every emulator. Thrown inside handlers and serialized
// by the router according to the protocol of the service that failed (JSON
// __type / Query XML ErrorResponse / S3 XML Error / Lambda REST). The `code`
// must be the exact AWS error name — the provisioner's idempotency and the
// SDK's error mapping depend on it (see docs/PRD_SELF_ENGINE.md §RF2.4).

export type AwsErrorFault = 'Sender' | 'Receiver';

export class AwsError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fault: AwsErrorFault;
  // Full namespaced __type for JSON protocols when it differs from `code`
  // (e.g. "com.amazonaws.dynamodb.v20120810#ResourceNotFoundException").
  readonly typeName?: string;
  // Extra top-level fields serialized into the JSON error payload (e.g.
  // DynamoDB's CancellationReasons).
  readonly extra?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options?: { status?: number; fault?: AwsErrorFault; typeName?: string; extra?: Record<string, unknown> },
  ) {
    super(message);
    this.name = 'AwsError';
    this.code = code;
    this.status = options?.status ?? 400;
    this.fault = options?.fault ?? 'Sender';
    this.typeName = options?.typeName;
    this.extra = options?.extra;
  }
}

const DYNAMO_NS = 'com.amazonaws.dynamodb.v20120810';

export function dynamoError(code: string, message: string, status = 400): AwsError {
  return new AwsError(code, message, { status, typeName: `${DYNAMO_NS}#${code}` });
}

export function validationError(message: string): AwsError {
  return dynamoError('ValidationException', message);
}

export function sqsError(code: string, message: string, status = 400): AwsError {
  return new AwsError(code, message, { status });
}

export function s3Error(code: string, message: string, status: number): AwsError {
  return new AwsError(code, message, { status });
}

// Service-level gap (router): the whole service is unknown to the engine, so
// the fallback proxy WOULD forward it — suggesting fallbackEndpoint is honest
// here (this error is only reachable when no fallback is configured).
export function notImplemented(service: string, operation: string): AwsError {
  return new AwsError(
    'NotImplemented',
    `${service}.${operation} is not implemented by the LSS self engine — ` +
      'see docs/SELF_ENGINE.md#coverage, or set selfEngine.fallbackEndpoint to forward it to a LocalStack instance',
    { status: 400 },
  );
}

// Operation-level gap inside a service the engine DOES serve: the fallback
// proxy never forwards these (and it would read the wrong state anyway — the
// service's data lives in the self engine), so the message must not send
// people down the fallbackEndpoint dead end.
export function notImplementedOperation(service: string, operation: string): AwsError {
  return new AwsError(
    'NotImplemented',
    `${service}.${operation} is not implemented by the LSS self engine — see docs/SELF_ENGINE.md#coverage. ` +
      `(selfEngine.fallbackEndpoint does not apply here: it forwards whole services the engine does not serve, ` +
      `and ${service} — with its data — is served by the self engine.)`,
    { status: 400 },
  );
}
