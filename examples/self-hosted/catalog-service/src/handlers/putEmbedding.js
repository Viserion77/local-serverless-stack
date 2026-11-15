const { PutCommand } = require('@aws-sdk/lib-dynamodb');
const { doc, TABLE } = require('./dynamo');
const { embed } = require('./embedding');

// PUT /products/{id}/embedding — body: { "name": "...", "category": "...", "description": "..." }
// Derives the (toy) embedding from the product text and stores it on the
// item. The vector is a plain list attribute: DynamoDB validates its length
// against the index's Dimensions and indexes it under the item's category.
exports.handler = async (event) => {
  const productId = event.pathParameters && event.pathParameters.id;
  let payload = {};
  try {
    payload = event.body ? JSON.parse(event.body) : {};
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid json' }) };
  }
  const { name, category, description = '' } = payload;
  if (!name || !category) {
    return { statusCode: 400, body: JSON.stringify({ error: 'name and category are required' }) };
  }

  const item = { productId, category, name, description, embedding: embed(`${name} ${description}`) };
  await doc.send(new PutCommand({ TableName: TABLE, Item: item }));
  return { statusCode: 200, body: JSON.stringify(item) };
};
