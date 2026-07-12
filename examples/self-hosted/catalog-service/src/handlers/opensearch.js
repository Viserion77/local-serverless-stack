// Minimal OpenSearch REST helper over Node's global fetch. The LSS self
// engine skips SigV4 verification, so plain HTTP is enough locally; against
// real OpenSearch Serverless swap this for @opensearch-project/opensearch
// with AwsSigv4Signer({service: 'aoss'}) — the calls themselves are identical.
const ENDPOINT = process.env.OPENSEARCH_ENDPOINT || 'http://localhost:14566/_aoss/products-catalog';
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
