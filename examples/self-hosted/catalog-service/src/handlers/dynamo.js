// DynamoDB DocumentClient for the vector-search handlers. The LSS runtime
// injects AWS_ENDPOINT_URL (the engine), which AWS SDK v3 reads natively; the
// explicit fallback keeps a bare `node` run pointed at the default port.
//
// @aws-sdk/* is resolved from the repository's root node_modules (Node walks
// up from this file), which carries a client recent enough for
// SearchVectorsCommand (>= 3.1169). Copied out of the repo, the service needs
// its own `npm install @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb`.
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({
  region: process.env.AWS_REGION || 'us-west-2',
  endpoint: process.env.AWS_ENDPOINT_URL || 'http://localhost:14566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
}));

const TABLE = process.env.EMBEDDINGS_TABLE || 'catalog-embeddings';
const INDEX = process.env.EMBEDDINGS_INDEX || 'ProductEmbeddingIndex';

module.exports = { doc, TABLE, INDEX };
