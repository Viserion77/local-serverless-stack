// The tool surface an MCP client (Claude Code) gets over the running
// orchestrator. Everything here is a thin, typed wrapper over the same REST API
// the dashboard and the LssClient use — no second source of truth, and no AWS
// SDK in this process.
//
// Design rules for this file:
//   - Read-only tools first; anything that mutates says so in its description,
//     because the client shows those descriptions to a human before approving.
//   - Every tool answers TEXT (JSON, pretty-printed). MCP clients render text
//     reliably; structured content is optional in the spec and unevenly
//     supported.
//   - Errors come back as `isError` results, not JSON-RPC errors: a failed tool
//     call is a normal outcome the model should read and react to, not a
//     transport fault.

export interface HttpLike {
  (method: string, path: string, body?: unknown): Promise<unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  // Mutating tools are flagged so a client can group/annotate them.
  mutates?: boolean;
  run: (args: Record<string, unknown>, http: HttpLike) => Promise<unknown>;
}

const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });
const obj = (description: string) => ({ type: 'object', description });

function region(args: Record<string, unknown>): string {
  return typeof args.region === 'string' && args.region ? `?region=${encodeURIComponent(args.region)}` : '';
}

function name(args: Record<string, unknown>, key = 'name'): string {
  const value = args[key];
  if (typeof value !== 'string' || !value) throw new Error(`"${key}" is required`);
  return encodeURIComponent(value);
}

const REGION_PROP = {
  region: str('AWS region. Defaults to the region the orchestrator is configured with.'),
};

export const TOOLS: ToolDefinition[] = [
  {
    name: 'lss_health',
    description:
      'Orchestrator and engine health: the engine endpoint, the AWS services it answers for, '
      + 'how many event-source loops and schedule rules are armed. Use this first to confirm a stack is up.',
    inputSchema: { type: 'object', properties: {} },
    run: (_a, http) => http('GET', '/api/health'),
  },
  {
    name: 'lss_config',
    description:
      'Effective LSS configuration (secret values never included): ports, engine, region, seeds dir, '
      + 'lambda runtime residency policy, and which keys are currently masked by an environment variable.',
    inputSchema: { type: 'object', properties: {} },
    run: (_a, http) => http('GET', '/api/config'),
  },
  {
    name: 'lss_ports',
    description: 'Every local port this stack exposes: orchestrator, engine, and each service\'s HTTP API and invoke listener.',
    inputSchema: { type: 'object', properties: {} },
    run: (_a, http) => http('GET', '/api/config/ports'),
  },
  {
    name: 'lss_services',
    description:
      'Registered services with their resource breakdown, HTTP routes, runtime status and ports. '
      + '`runtimeWarm: false` means the service is ready but its worker has not been forked yet.',
    inputSchema: { type: 'object', properties: {} },
    run: (_a, http) => http('GET', '/api/services'),
  },
  {
    name: 'lss_service_graph',
    description:
      'How ONE service is wired, derived from its packaged CloudFormation template: nodes (its functions, '
      + 'tables, queues, topics, buckets, buses, rules, collections, secrets, HTTP routes and shared IAM roles, '
      + 'plus the resources of OTHER services it references) and the edges between them — each carrying the '
      + 'evidence it came from (http-route, authorizer, event-source, s3-notification, event-rule-target, '
      + 'sns-subscription, redrive, iam grant, env var) and whether that evidence is `declared` or merely '
      + '`inferred` from a name match. Use it to answer "what triggers this function" or "who writes that table" '
      + 'without reading the template. It reports what the service DECLARED, not live traffic, so it answers '
      + 'for a stopped service too.',
    inputSchema: {
      type: 'object',
      properties: { name: str('Service name, as listed by lss_services.') },
      required: ['name'],
    },
    run: (a, http) => http('GET', `/api/services/${name(a)}/graph`),
  },
  {
    name: 'lss_scan_services',
    description:
      'Discover Serverless Framework / osls services under the project root that could be registered: '
      + 'name, path, installed/packaged/registered flags, effective ports and package command. '
      + 'Use before lss_register_service.',
    inputSchema: { type: 'object', properties: {} },
    run: (_a, http) => http('GET', '/api/services/scan'),
  },
  {
    name: 'lss_register_service',
    description:
      'MUTATES. Register a service with the orchestrator by its directory path. Packaging runs on demand '
      + '(autoPackage) and name/region/ports resolve from the packaged serverless-state.json — a bare path is enough. '
      + 'This provisions the service\'s AWS resources on the engine.',
    mutates: true,
    inputSchema: {
      type: 'object',
      properties: {
        servicePath: str('Absolute path of the service directory (from lss_scan_services `root`).'),
        apiPort: num('Override the HTTP API port. Optional.'),
        invokePort: num('Override the Lambda invoke port. Optional.'),
        region: str('Override the AWS region. Optional.'),
      },
      required: ['servicePath'],
    },
    run: (a, http) => {
      if (typeof a.servicePath !== 'string' || !a.servicePath) throw new Error('"servicePath" is required');
      return http('POST', '/api/services/register', {
        servicePath: a.servicePath,
        apiPort: a.apiPort,
        invokePort: a.invokePort,
        region: a.region,
      });
    },
  },
  {
    name: 'lss_resources',
    description: 'Provisioned AWS resources (DynamoDB tables, SQS queues, SNS topics, S3 buckets, OpenSearch collections).',
    inputSchema: { type: 'object', properties: { ...REGION_PROP } },
    run: (a, http) => http('GET', `/api/resources${region(a)}`),
  },
  {
    name: 'lss_resource_owners',
    description: 'Maps each provisioned resource to the service that declared it — use it to find who owns a table or queue.',
    inputSchema: { type: 'object', properties: { ...REGION_PROP } },
    run: (a, http) => http('GET', `/api/resources/owners${region(a)}`),
  },
  {
    name: 'lss_lambdas',
    description: 'Every registered function with its triggers, execution mode, invocation counters and warm state.',
    inputSchema: { type: 'object', properties: {} },
    run: (_a, http) => http('GET', '/api/lambdas'),
  },
  {
    name: 'lss_lambda_logs',
    description: 'Invocation history for one function: duration, ok/error, HTTP status and the captured log lines per call.',
    inputSchema: {
      type: 'object',
      properties: { name: str('Function name (short name or fully qualified).') },
      required: ['name'],
    },
    run: (a, http) => http('GET', `/api/lambdas/${name(a)}/logs`),
  },
  {
    name: 'lss_invoke',
    description:
      'MUTATES. Invoke a Lambda with a JSON payload and return its result plus captured logs. '
      + 'This runs the real handler against the real local AWS state.',
    mutates: true,
    inputSchema: {
      type: 'object',
      properties: {
        name: str('Function name (short name or fully qualified).'),
        payload: obj('Event object passed to the handler. Defaults to {}.'),
        async: { type: 'boolean', description: 'Fire and forget (Event invocation type). Defaults to false.' },
      },
      required: ['name'],
    },
    run: (a, http) =>
      http('POST', `/api/lambdas/${name(a)}/invoke`, {
        payload: a.payload ?? {},
        invocationType: a.async ? 'Event' : 'RequestResponse',
      }),
  },
  {
    name: 'lss_apis',
    description: 'HTTP routes served per service: method, path, target function, payload version, authorizer and listener status.',
    inputSchema: { type: 'object', properties: {} },
    run: (_a, http) => http('GET', '/api/apis'),
  },
  {
    name: 'lss_dynamo_tables',
    description: 'DynamoDB tables with key schema, GSI/LSI, stream and TTL state. Paginated internally — all tables are returned.',
    inputSchema: { type: 'object', properties: { ...REGION_PROP } },
    run: (a, http) => http('GET', `/api/dynamo/tables${region(a)}`),
  },
  {
    name: 'lss_dynamo_scan',
    description:
      'Scan a DynamoDB table. Supports filterExpression / projectionExpression / expressionAttributeNames / '
      + 'expressionAttributeValues / indexName / limit / exclusiveStartKey, exactly like the AWS SDK.',
    inputSchema: {
      type: 'object',
      properties: {
        table: str('Table name.'),
        input: obj('ScanInput fields (filterExpression, limit, indexName, ...). Optional.'),
        ...REGION_PROP,
      },
      required: ['table'],
    },
    run: (a, http) => http('POST', `/api/dynamo/tables/${name(a, 'table')}/scan${region(a)}`, a.input ?? {}),
  },
  {
    name: 'lss_dynamo_query',
    description: 'Query a DynamoDB table or index. Requires keyConditionExpression in `input`.',
    inputSchema: {
      type: 'object',
      properties: {
        table: str('Table name.'),
        input: obj('QueryInput fields — keyConditionExpression is required.'),
        ...REGION_PROP,
      },
      required: ['table', 'input'],
    },
    run: (a, http) => http('POST', `/api/dynamo/tables/${name(a, 'table')}/query${region(a)}`, a.input ?? {}),
  },
  {
    name: 'lss_dynamo_put_item',
    description: 'MUTATES. Write one item into a DynamoDB table. `item` is a plain JSON object (not AttributeValue-typed).',
    mutates: true,
    inputSchema: {
      type: 'object',
      properties: { table: str('Table name.'), item: obj('Plain JSON item.'), ...REGION_PROP },
      required: ['table', 'item'],
    },
    run: (a, http) => http('POST', `/api/dynamo/tables/${name(a, 'table')}/items${region(a)}`, { item: a.item }),
  },
  {
    name: 'lss_queues',
    description:
      'SQS queues with live metrics (available, in flight, delayed, processed) and the Lambda consumers attached to each.',
    inputSchema: { type: 'object', properties: { ...REGION_PROP } },
    run: (a, http) => http('GET', `/api/queues${region(a)}`),
  },
  {
    name: 'lss_queue_send',
    description: 'MUTATES. Send a message to a queue. FIFO queues accept messageGroupId / messageDeduplicationId.',
    mutates: true,
    inputSchema: {
      type: 'object',
      properties: {
        queue: str('Queue name (logical name, e.g. "orders-to-process").'),
        body: str('Message body.'),
        messageGroupId: str('FIFO group id.'),
        messageDeduplicationId: str('FIFO dedup id.'),
        delaySeconds: num('Delivery delay in seconds.'),
        ...REGION_PROP,
      },
      required: ['queue', 'body'],
    },
    run: (a, http) =>
      http('POST', `/api/queues/${name(a, 'queue')}/messages${region(a)}`, {
        body: a.body,
        messageGroupId: a.messageGroupId,
        messageDeduplicationId: a.messageDeduplicationId,
        delaySeconds: a.delaySeconds,
      }),
  },
  {
    name: 'lss_queue_await_idle',
    description:
      'Block until a queue drains (available and in-flight both zero), then return. The reliable way to wait for an '
      + 'async pipeline to finish before asserting. Pass `sinceProcessed` to also require a minimum processed count. '
      + 'Answers even on timeout — check the `drained` field.',
    inputSchema: {
      type: 'object',
      properties: {
        queue: str('Queue name.'),
        timeoutMs: num('How long to wait. Server clamps to 100..120000. Default 15000.'),
        sinceProcessed: num('Also require at least this many messages processed.'),
        ...REGION_PROP,
      },
      required: ['queue'],
    },
    run: (a, http) =>
      http('POST', `/api/queues/${name(a, 'queue')}/await-idle${region(a)}`, {
        timeoutMs: a.timeoutMs,
        sinceProcessed: a.sinceProcessed,
      }),
  },
  {
    name: 'lss_buckets',
    description: 'S3 buckets with object count, total size, versioning and notification configuration.',
    inputSchema: { type: 'object', properties: { ...REGION_PROP } },
    run: (a, http) => http('GET', `/api/buckets${region(a)}`),
  },
  {
    name: 'lss_bucket_objects',
    description: 'List objects in a bucket. Supports prefix and delimiter.',
    inputSchema: {
      type: 'object',
      properties: {
        bucket: str('Bucket name.'),
        prefix: str('Key prefix filter.'),
        delimiter: str('Group keys by this delimiter (e.g. "/").'),
        ...REGION_PROP,
      },
      required: ['bucket'],
    },
    run: (a, http) => {
      const params = new URLSearchParams();
      if (typeof a.prefix === 'string' && a.prefix) params.set('prefix', a.prefix);
      if (typeof a.delimiter === 'string' && a.delimiter) params.set('delimiter', a.delimiter);
      if (typeof a.region === 'string' && a.region) params.set('region', a.region);
      const query = params.toString();
      return http('GET', `/api/buckets/${name(a, 'bucket')}/objects${query ? `?${query}` : ''}`);
    },
  },
  {
    name: 'lss_secrets',
    description: 'Secrets Manager entries (names, ARNs, version stages, tags). Values are NOT included.',
    inputSchema: { type: 'object', properties: { ...REGION_PROP } },
    run: (a, http) => http('GET', `/api/secrets${region(a)}`),
  },
  {
    name: 'lss_opensearch_search',
    description: 'Run an OpenSearch query against a collection. `body` is the raw search DSL.',
    inputSchema: {
      type: 'object',
      properties: {
        collection: str('Collection name.'),
        body: obj('OpenSearch query DSL (query, sort, size, aggs, ...).'),
        index: str('Index to search. Defaults to the collection\'s only index when there is one.'),
        ...REGION_PROP,
      },
      required: ['collection'],
    },
    run: (a, http) =>
      http('POST', `/api/opensearch/collections/${name(a, 'collection')}/search${region(a)}`, {
        index: a.index,
        body: a.body ?? {},
      }),
  },
  {
    name: 'lss_seeds',
    description: 'Seed files on disk and the live tables they map to — including the mismatch diagnostic.',
    inputSchema: { type: 'object', properties: { ...REGION_PROP } },
    run: (a, http) => http('GET', `/api/seeds${region(a)}`),
  },
  {
    name: 'lss_seed_run',
    description: 'MUTATES. Apply seed files into DynamoDB. Omit `table` to apply every seed file.',
    mutates: true,
    inputSchema: {
      type: 'object',
      properties: { table: str('Seed a single table. Omit for all.'), ...REGION_PROP },
      required: [],
    },
    run: (a, http) =>
      http('POST', `/api/seeds/run${region(a)}`, typeof a.table === 'string' && a.table ? { tableName: a.table } : {}),
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map(tool => [tool.name, tool]));

// The wire shape a client sees — `run` is server-side only.
export function toolListPayload(): unknown[] {
  return TOOLS.map(({ name: toolName, description, inputSchema }) => ({
    name: toolName,
    description,
    inputSchema,
  }));
}
