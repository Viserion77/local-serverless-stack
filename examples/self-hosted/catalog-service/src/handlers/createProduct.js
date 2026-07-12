const { randomUUID } = require('crypto');
const { request, INDEX } = require('./opensearch');

// POST /products — body: { "name": "...", "category": "...", "price": 12.5, "tags": ["..."] }
exports.handler = async (event) => {
  let payload = {};
  try {
    payload = event.body ? JSON.parse(event.body) : {};
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid json' }) };
  }

  const { name, category, price, tags } = payload;
  if (!name || !category || typeof price !== 'number') {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'name, category and numeric price are required' }),
    };
  }

  const id = payload.id || randomUUID();
  const product = {
    name,
    category,
    price,
    tags: Array.isArray(tags) ? tags : [],
    createdAt: new Date().toISOString(),
  };

  const { status, json } = await request('PUT', `/${INDEX}/_doc/${encodeURIComponent(id)}`, product);
  if (status >= 400) {
    return { statusCode: 502, body: JSON.stringify({ error: 'indexing failed', detail: json }) };
  }

  console.log(`[createProduct] ${id} indexed (${json.result})`);
  return { statusCode: 201, body: JSON.stringify({ id, ...product }) };
};
