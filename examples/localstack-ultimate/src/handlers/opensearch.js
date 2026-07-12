// Minimal OpenSearch REST helper over Node's global fetch. LocalStack has no
// OpenSearch Serverless (aoss) in any edition, so the LSS orchestrator serves
// the ultimate-products collection in-process (aoss sidecar on :14567) and
// skips SigV4 verification — plain HTTP is enough locally. Against real
// OpenSearch Serverless swap this for @opensearch-project/opensearch with
// AwsSigv4Signer({service: 'aoss'}) — the calls themselves are identical.
const ENDPOINT = process.env.OPENSEARCH_ENDPOINT || 'http://localhost:14567/_aoss/ultimate-products';
const INDEX = process.env.PRODUCTS_INDEX || 'products';

async function request(method, path, body) {
  const res = await fetch(`${ENDPOINT}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = {};
  try {
    json = await res.json();
  } catch {
    // HEAD/empty responses have no body
  }
  return { status: res.status, json };
}

module.exports = { request, INDEX };
