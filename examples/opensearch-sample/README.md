# opensearch-sample

A product-catalog microservice using **OpenSearch Serverless on the LSS self engine** —
the collection is declared in `serverless.yml` as `AWS::OpenSearchServerless::Collection`,
provisioned on registration, and served in-process by the orchestrator. **No Docker. No
OpenSearch cluster. No auth token.** The handlers speak the plain OpenSearch REST API
against the local collection endpoint with Node's global `fetch` — zero runtime
dependencies.

| Service | Role | API port | Invoke port |
|---|---|---|---|
| `catalog-service` | `POST /products` indexes documents; `GET /products/{id}` / `DELETE /products/{id}` read and remove them; `GET /search` runs full-text + filtered queries; `GET /stats` aggregates by category. Owns the `products-catalog` collection. | `3041` | `13041` |

What this exercises on the self engine:

- **Collection provisioning** — `AWS::OpenSearchServerless::Collection` from `resources:`
  is created via the real `aoss` control plane (`CreateCollection`); the
  `SecurityPolicy`/`AccessPolicy` resources are accepted and skipped with a registration
  warning (nothing enforces them locally), so the template stays deployable to real AWS.
- **Document CRUD** — `PUT/GET/DELETE /<index>/_doc/<id>` with versioning; the `products`
  index is auto-created on the first write, like OpenSearch defaults.
- **Search** — `multi_match` full text over `name`/`tags`, `bool` composition with
  `term`/`range` filters, `sort`, and pagination.
- **Aggregations** — `terms` buckets per category plus an `avg` metric, computed over all
  matches.
- **Persistence** — collections and index metadata are JSON catalogs, documents live in a
  JSONL table per index under `.lss/engine/` (hydrated lazily, unloaded when idle) and
  survive an orchestrator restart.

> **Ports** — LSS server `3150`, self engine `14566`, service API `3041`, invoke `13041`.
> The collection endpoint is `http://localhost:14566/_aoss/products-catalog` — the same
> URL `BatchGetCollection` reports as `collectionEndpoint`.

## Prerequisites

- Node.js ≥ 20. That's it — **no Docker required**.

## Run

```bash
cd examples/opensearch-sample

# Install the service's dev dependencies (serverless + the LSS plugin)
npm run setup

# 1. Start LSS with the self engine
npm run lss:start

# 2. Register the service (sls package → auto-registration)
npm run register:catalog

# 3. Watch it in the dashboard
open http://localhost:3150
```

## Drive the catalog

```bash
# Index a few products
curl -s -X POST localhost:3041/products -d '{"name":"Wireless Mouse","category":"peripherals","price":25,"tags":["usb","wireless"]}'
curl -s -X POST localhost:3041/products -d '{"name":"Mechanical Keyboard","category":"peripherals","price":90,"tags":["usb"]}'
curl -s -X POST localhost:3041/products -d '{"name":"USB Hub","category":"accessories","price":15,"tags":["usb"]}'

# Full-text search
curl -s 'localhost:3041/search?q=wireless'

# Filters compose with the text query
curl -s 'localhost:3041/search?category=peripherals&maxPrice=50'

# Aggregations: products and average price per category
curl -s localhost:3041/stats
```

The engine also answers the OpenSearch REST API directly — handy for debugging:

```bash
curl -s 'http://localhost:14566/_aoss/products-catalog/_cat/indices'
curl -s 'http://localhost:14566/_aoss/products-catalog/products/_search?q=name:mouse'
curl -s 'http://localhost:14566/_aoss/products-catalog/products/_count'
```

## Moving to real AWS

The `serverless.yml` deploys as-is (the encryption and data-access policies are already
declared). In the handlers, swap the `fetch` helper for the official client — the request
shapes are identical:

```js
const { Client } = require('@opensearch-project/opensearch');
const { AwsSigv4Signer } = require('@opensearch-project/opensearch/aws');

const client = new Client({
  ...AwsSigv4Signer({ region: process.env.AWS_REGION, service: 'aoss', getCredentials: ... }),
  node: process.env.OPENSEARCH_ENDPOINT, // GetAtt ProductsCollection.CollectionEndpoint
});
```

## Coverage notes

The self engine implements the everyday subset: document/index CRUD, `_bulk`, `_search`
(match/term/terms/range/prefix/wildcard/exists/ids/bool), `sort`, `_source` filtering,
`terms`/`avg`/`sum`/`min`/`max`/`value_count` aggregations, `_count`, `_mapping`,
`_cat/indices`. Anything else answers an explicit OpenSearch-shaped error naming the
operation — see [docs/SELF_ENGINE.md](../../docs/SELF_ENGINE.md#coverage). Scoring is
constant (`_score: 1`): filtering is exact, ranking is not emulated.

## Stop / reset

```bash
npm run lss:stop        # stop the orchestrator
rm -rf .lss             # wipe engine state (collections, indices, documents)
```
