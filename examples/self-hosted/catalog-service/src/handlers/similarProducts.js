const { GetCommand, SearchVectorsCommand } = require('@aws-sdk/lib-dynamodb');
const { doc, TABLE, INDEX } = require('./dynamo');

// GET /products/{id}/similar?k=5 — the k products most similar to {id}, from
// the same category. One SearchVectors call: the product's own embedding is
// the query, the category is the index's HASH (mandatory in the condition),
// and TopK asks for one extra hit because the product is its own nearest
// neighbour. Scores are cosine distances: lower is closer.
exports.handler = async (event) => {
  const productId = event.pathParameters && event.pathParameters.id;
  const params = event.queryStringParameters || {};
  const k = Math.min(Math.max(parseInt(params.k || '5', 10) || 5, 1), 99);

  const { Item: product } = await doc.send(new GetCommand({ TableName: TABLE, Key: { productId } }));
  if (!product || !Array.isArray(product.embedding)) {
    return { statusCode: 404, body: JSON.stringify({ error: `product ${productId} has no embedding` }) };
  }

  const { SearchResults = [] } = await doc.send(new SearchVectorsCommand({
    TableName: TABLE,
    IndexName: INDEX,
    SearchVector: product.embedding,
    TopK: k + 1,
    SearchConditionExpression: 'category = :category',
    ExpressionAttributeValues: { ':category': product.category },
  }));

  const similar = SearchResults
    .filter((result) => result.Item.productId !== productId)
    .slice(0, k)
    .map((result) => ({ productId: result.Item.productId, name: result.Item.name, score: result.Score }));
  return { statusCode: 200, body: JSON.stringify({ productId, category: product.category, similar }) };
};
