const { request, INDEX } = require('./opensearch');
const respond = require('./respond');

// DELETE /products/{id}
exports.handler = async (event) => {
  const id = event.pathParameters && event.pathParameters.id;
  const { status } = await request('DELETE', `/${INDEX}/_doc/${encodeURIComponent(id)}`);

  if (status === 404) {
    return respond(404, { error: `product ${id} not found` });
  }
  console.log(`[deleteProduct] ${id} deleted`);
  return respond(200, { deleted: id });
};
