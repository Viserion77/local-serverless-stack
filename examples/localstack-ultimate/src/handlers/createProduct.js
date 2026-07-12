const { randomUUID } = require('crypto');
const { request, INDEX } = require('./opensearch');
const respond = require('./respond');

// POST /products — body: { "name": "...", "category": "...", "price": 12.5, "tags": ["..."] }
exports.handler = async (event) => {
  let payload = {};
  try {
    payload = event.body ? JSON.parse(event.body) : {};
  } catch {
    return respond(400, { error: 'invalid json' });
  }

  const { name, category, price, tags } = payload;
  if (!name || !category || typeof price !== 'number') {
    return respond(400, { error: 'name, category and numeric price are required' });
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
    return respond(502, { error: 'indexing failed', detail: json });
  }

  console.log(`[createProduct] ${id} indexed (${json.result})`);
  return respond(201, { id, ...product });
};
