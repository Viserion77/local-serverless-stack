// HTTP API (payload v2) REQUEST authorizer with "simple responses" enabled:
// return {isAuthorized, context} instead of an IAM policy. v2 lowercases all
// header names, so `authorization` is safe to read directly.
export const handler = async (event: any) => {
  const token = event.headers?.authorization;

  if (token === `Bearer ${process.env.SESSION_SECRET}`) {
    return { isAuthorized: true, context: { user: 'ts-user' } };
  }

  return { isAuthorized: false };
};
