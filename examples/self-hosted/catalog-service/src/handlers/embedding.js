// A deterministic TOY embedding — no model, no network, no API key — so the
// vector-search flow runs anywhere. Feature hashing: every word of the text
// is hashed (FNV-1a, 32-bit) into one of DIMENSIONS buckets with a ±1 sign
// taken from another bit of the hash (signed hashing keeps collisions from
// piling up in one direction), then the vector is L2-normalised so COSINE
// compares direction only.
//
// Texts that share words land close together; that is all the example needs
// to show SearchVectors ranking neighbours. A real service would call an
// embedding model here (and the index would have 256..4096 dimensions); the
// DynamoDB side — PutItem the vector, SearchVectors to query it — is identical.
const DIMENSIONS = 8;

function fnv1a(word) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < word.length; i++) {
    hash ^= word.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function embed(text) {
  const vector = new Array(DIMENSIONS).fill(0);
  const words = String(text).toLowerCase().match(/[a-z0-9]+/g) || [];
  for (const word of words) {
    const hash = fnv1a(word);
    vector[hash % DIMENSIONS] += (hash >>> 16) & 1 ? 1 : -1;
  }
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0)) || 1;
  // Rounded so the stored item (and the seed file) stays readable; the index
  // keeps f32 precision anyway.
  return vector.map((x) => Math.round((x / norm) * 1e6) / 1e6);
}

module.exports = { embed, DIMENSIONS };
