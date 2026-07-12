// SigV4 credential-scope parsing. The engine never verifies signatures — the
// scope is only mined for {service, region} so one port can route every AWS
// SDK request deterministically (see docs/PRD_SELF_ENGINE.md §RF2.1).

export interface SigV4Scope {
  accessKeyId: string;
  date: string;
  region: string;
  service: string;
}

// Parse "AKID/20260710/us-east-1/dynamodb/aws4_request" (the value of
// Credential= in the Authorization header or the X-Amz-Credential query
// param). Returns undefined for anything not scope-shaped.
export function parseCredentialScope(credential: string): SigV4Scope | undefined {
  const parts = credential.split('/');
  if (parts.length !== 5 || parts[4] !== 'aws4_request') return undefined;
  const [accessKeyId, date, region, service] = parts;
  if (!region || !service) return undefined;
  return { accessKeyId, date, region, service };
}

// Resolve the scope of a request: Authorization header first (SDK-signed
// requests), then the presigned-URL X-Amz-Credential query param.
export function resolveSigV4Scope(
  headers: Record<string, string>,
  query: Record<string, string>,
): SigV4Scope | undefined {
  const authorization = headers['authorization'];
  if (authorization && authorization.startsWith('AWS4-HMAC-SHA256')) {
    const match = /Credential=([^,\s]+)/.exec(authorization);
    if (match) {
      const scope = parseCredentialScope(match[1]);
      if (scope) return scope;
    }
  }
  const presigned = query['X-Amz-Credential'];
  if (presigned) return parseCredentialScope(presigned);
  return undefined;
}
