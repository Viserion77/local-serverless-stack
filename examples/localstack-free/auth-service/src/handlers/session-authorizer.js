const { GetCommand } = require('@aws-sdk/lib-dynamodb');
const { doc } = require('./aws');

// v1 REQUEST authorizer (classic IAM-policy response). It has no HTTP events of
// its own: `whoami` references it locally by name, and orders-service references
// it cross-service by ARN. It reads the `code` header, looks the session up in
// DynamoDB, and Allows (with the user in context) or Denies.
exports.handler = async (event) => {
  const code = headerValue(event.headers, 'code');

  if (code) {
    const res = await doc.send(new GetCommand({
      TableName: process.env.SESSIONS_TABLE,
      Key: { code },
    }));

    if (res.Item) {
      return policy(res.Item.user, 'Allow', event.methodArn, { user: res.Item.user });
    }
  }

  return policy('anonymous', 'Deny', event.methodArn);
};

// Header names may arrive in any casing depending on the client.
function headerValue(headers, name) {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

function policy(principalId, effect, methodArn, context) {
  return {
    principalId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Action: 'execute-api:Invoke',
          Effect: effect,
          Resource: methodArn,
        },
      ],
    },
    ...(context && { context }),
  };
}
