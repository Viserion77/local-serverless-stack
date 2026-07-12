const { request, INDEX } = require('./opensearch');

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
    return { statusCode: 200, body: JSON.stringify({ total: 0, averagePrice: null, categories: [] }) };
  }
  if (status >= 400) {
    return { statusCode: 502, body: JSON.stringify({ error: 'aggregation failed', detail: json }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      total: json.hits.total.value,
      averagePrice: json.aggregations.avg_price.value,
      categories: json.aggregations.by_category.buckets.map((bucket) => ({
        category: bucket.key,
        products: bucket.doc_count,
      })),
    }),
  };
};
