// GET /whoami — protected route. The authorizer's context is surfaced on
// event.requestContext.authorizer, exactly as API Gateway v1 does.
exports.handler = async (event) => {
  const authorizer = (event.requestContext && event.requestContext.authorizer) || {};
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: authorizer.user }),
  };
};
