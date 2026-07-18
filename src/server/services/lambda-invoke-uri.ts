// The AWS Lambda Invoke API path, and the API Gateway "invocation URI" that
// wraps it. Both live here so the two consumers can never drift apart:
//
//   * GatewayManager serves the path on every service's invokePort
//     (`POST /2015-03-31/functions/<fn>/invocations`).
//   * The raw AWS::ApiGatewayV2 assembler receives the SAME path embedded in an
//     ARN, because that is how CloudFormation addresses a Lambda integration or
//     REQUEST authorizer target:
//
//       arn:aws:apigateway:<region>:lambda:path/2015-03-31/functions/<lambdaArn>/invocations
//
//     That value is NOT a Lambda ARN — it must be unwrapped before it can be
//     resolved against the function registry. Both the Serverless Framework's
//     compiled `AuthorizerUri` (an Fn::Join) and the hand-written `!Sub` idiom
//     reduce to exactly this string.
//
// `<fn>` is a bare function name or a full Lambda ARN; neither ever contains a
// '/', so a single greedy-free segment is the right capture.
const INVOKE_PATH_PATTERN = '/2015-03-31/functions/([^/]+)/invocations/?';

// Anchored form used to route an incoming Invoke API request.
export const LAMBDA_INVOKE_PATH = new RegExp(`^${INVOKE_PATH_PATTERN}$`);

// The apigateway-service ARN wrapper. The region segment is allowed to be empty
// because CloudFormation templates in the wild sometimes emit `:apigateway::`.
const APIGW_INVOKE_URI = new RegExp(`^arn:[^:]+:apigateway:[^:]*:lambda:path${INVOKE_PATH_PATTERN}$`);

// The inner Lambda ARN/name of an API Gateway invocation URI, or the value
// unchanged when it is not wrapped (a plain ARN, a cross-stack literal, a bare
// name) — callers pass everything through this, wrapped or not.
export function unwrapLambdaInvokeUri(value: string): string {
  const match = APIGW_INVOKE_URI.exec(value);
  return match ? decodeURIComponent(match[1]) : value;
}
