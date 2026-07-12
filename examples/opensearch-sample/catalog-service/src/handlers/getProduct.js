const { request, INDEX } = require('./opensearch');

// GET /products/{id}
exports.handler = async (event) => {
  const id = event.pathParameters && event.pathParameters.id;
  const { status, json } = await request('GET', `/${INDEX}/_doc/${encodeURIComponent(id)}`);

  if (status === 404) {
    return { statusCode: 404, body: JSON.stringify({ error: `product ${id} not found` }) };
  }
  return { statusCode: 200, body: JSON.stringify({ id: json._id, ...json._source }) };
};
