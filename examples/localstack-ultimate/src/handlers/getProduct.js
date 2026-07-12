const { request, INDEX } = require('./opensearch');
const respond = require('./respond');

// GET /products/{id}
exports.handler = async (event) => {
  const id = event.pathParameters && event.pathParameters.id;
  const { status, json } = await request('GET', `/${INDEX}/_doc/${encodeURIComponent(id)}`);

  if (status === 404) {
    return respond(404, { error: `product ${id} not found` });
  }
  return respond(200, { id: json._id, ...json._source });
};
