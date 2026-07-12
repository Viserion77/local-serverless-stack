const { request, INDEX } = require('./opensearch');
const respond = require('./respond');

// GET /stats — product count and average price per category (aggregations).
exports.handler = async () => {
  const { status, json } = await request('POST', `/${INDEX}/_search`, {
    size: 0,
    aggs: {
      by_category: { terms: { field: 'category' } },
      avg_price: { avg: { field: 'price' } },
    },
  });

  // No index yet (nothing was ever created) → empty stats, not an error.
  if (status === 404) {
    return respond(200, { total: 0, averagePrice: null, categories: [] });
  }
  if (status >= 400) {
    return respond(502, { error: 'aggregation failed', detail: json });
  }

  return respond(200, {
    total: json.hits.total.value,
    averagePrice: json.aggregations.avg_price.value,
    categories: json.aggregations.by_category.buckets.map((bucket) => ({
      category: bucket.key,
      products: bucket.doc_count,
    })),
  });
};
