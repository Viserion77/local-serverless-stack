const { request, INDEX } = require('./opensearch');
const respond = require('./respond');

// GET /search?q=<text>&category=<exact>&maxPrice=<number>
// Composes a bool query: full-text match on name/tags, term filter on
// category, range filter on price — the everyday OpenSearch search shape.
exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const must = [];
  const filter = [];

  if (params.q) {
    must.push({ multi_match: { query: params.q, fields: ['name', 'tags'] } });
  }
  if (params.category) {
    filter.push({ term: { category: params.category } });
  }
  if (params.maxPrice) {
    filter.push({ range: { price: { lte: Number(params.maxPrice) } } });
  }

  const query = must.length + filter.length > 0 ? { bool: { must, filter } } : { match_all: {} };
  const { status, json } = await request('POST', `/${INDEX}/_search`, {
    query,
    sort: [{ price: 'asc' }],
    size: 20,
  });

  // The index only exists after the first product is created — an empty
  // catalog is an empty result, not an error.
  if (status === 404) {
    return respond(200, { total: 0, products: [] });
  }
  if (status >= 400) {
    return respond(502, { error: 'search failed', detail: json });
  }

  return respond(200, {
    total: json.hits.total.value,
    products: json.hits.hits.map((hit) => ({ id: hit._id, ...hit._source })),
  });
};
