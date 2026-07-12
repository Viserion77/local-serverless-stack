const { request, INDEX } = require('./opensearch');

// DELETE /products/{id}
exports.handler = async (event) => {
  const id = event.pathParameters && event.pathParameters.id;
  const { status } = await request('DELETE', `/${INDEX}/_doc/${encodeURIComponent(id)}`);

  if (status === 404) {
    return { statusCode: 404, body: JSON.stringify({ error: `product ${id} not found` }) };
  }
  console.log(`[deleteProduct] ${id} deleted`);
  return { statusCode: 200, body: JSON.stringify({ deleted: id }) };
};
