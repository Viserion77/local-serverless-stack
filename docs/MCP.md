# MCP server — driving LSS from an AI coding agent

`npx lss mcp` exposes the running stack to any [Model Context
Protocol](https://modelcontextprotocol.io) client as a set of tools. Instead of
pasting `curl` output into a chat, the agent inspects and drives your local AWS
directly: list what is provisioned, invoke a Lambda, scan a table, send a
message, wait for a queue to drain.

It is a thin, read-mostly wrapper over the orchestrator's REST API — the same
API the dashboard and the `LssClient` use. No AWS SDK, no second source of
truth, and **no new runtime dependency**: the JSON-RPC 2.0 stdio transport is
implemented in `src/mcp/` (~250 lines).

---

## Turning it on

The server is **off unless a client is configured to launch it**, and every MCP
client has its own on/off switch. Nothing is enabled just by installing LSS.

### Claude Code

This repository ships a project-scoped [`.mcp.json`](../.mcp.json):

```json
{
  "mcpServers": {
    "lss": { "command": "node", "args": ["./bin/cli.js", "mcp"] }
  }
}
```

In **your own** project, install LSS and use the published binary:

```json
{
  "mcpServers": {
    "lss": { "command": "npx", "args": ["lss", "mcp"] }
  }
}
```

Then:

- `/mcp` in Claude Code lists the server, its tools and its connection state.
- The same `/mcp` view enables or disables it — that is the on/off switch.
- Deleting the entry from `.mcp.json` removes it entirely.

### Any other MCP client

Point it at the command `npx lss mcp` with stdio transport. The server speaks
protocol revision `2024-11-05` and advertises only the `tools` capability.

### Environment

| Variable | Effect |
|---|---|
| `LSS_BASE_URL` | Orchestrator URL. Wins over everything else — use it when the agent runs somewhere other than the project directory. |
| `LSS_CONFIG` | Explicit config file to read `serverPort` from. |

With neither set, the server reads `serverPort` from `lss.config.json` (then
`.lssrc`) in its working directory, and falls back to `http://localhost:14566`.

> **The orchestrator has to be running.** `lss mcp` never boots one — it only
> talks HTTP to a stack you started with `lss start`. If nothing answers, every
> tool returns one actionable error telling the agent to run `npx lss start`.

---

## Tools

Tools whose description starts with **MUTATES** change state; a client shows
that text before asking a human to approve the call.

| Tool | What it answers |
|---|---|
| `lss_health` | Engine endpoint, the AWS services it answers for, how many event-source loops and schedule rules are armed |
| `lss_config` | Effective configuration (no secret values), including the lambda residency policy |
| `lss_ports` | Every local port: the stack's own (dashboard + API + AWS wire) plus each service's API and invoke listeners |
| `lss_services` | Registered services: resources, routes, runtime status, `runtimeWarm` |
| `lss_scan_services` | Serverless/osls services found under the project root, with installed/packaged/registered flags, effective ports and package command |
| `lss_register_service` | **MUTATES.** Register a service by path — the orchestrator packages and resolves the rest |
| `lss_resources` / `lss_resource_owners` | Provisioned resources, and which service declared each |
| `lss_lambdas` / `lss_lambda_logs` | Functions with triggers and counters; per-invocation logs |
| `lss_invoke` | **MUTATES.** Run a handler with a JSON event, sync or `Event` |
| `lss_apis` | HTTP routes per service, with authorizer and listener status |
| `lss_dynamo_tables` / `lss_dynamo_scan` / `lss_dynamo_query` | Table metadata and reads (full AWS expression language) |
| `lss_dynamo_put_item` | **MUTATES.** Write one plain-JSON item |
| `lss_queues` / `lss_queue_send` / `lss_queue_await_idle` | Queue metrics and consumers; send; block until drained |
| `lss_buckets` / `lss_bucket_objects` | S3 buckets and object listings (prefix/delimiter) |
| `lss_secrets` | Secret names, ARNs and version stages — **never values** |
| `lss_opensearch_search` | Raw OpenSearch DSL against a collection |
| `lss_seeds` / `lss_seed_run` | Seed files vs live tables; **MUTATES** on run |

Every tool takes an optional `region`; omitted, the orchestrator's configured
region is used.

### The one that makes agents useful on async work

`lss_queue_await_idle` blocks server-side until a queue drains, then returns.
It is what lets an agent do arrange → act → **wait** → assert on a pipeline that
crosses SQS and Lambda, instead of guessing at a sleep:

```
lss_invoke            createOrder with an event
lss_queue_await_idle  orders-to-process, sinceProcessed: 1
lss_dynamo_scan       notifications-Notifications
```

---

## Design notes

- **Text results.** Every tool answers pretty-printed JSON in a `text` content
  block. Structured content is optional in the MCP spec and unevenly supported;
  text renders everywhere.
- **Failures are results, not transport errors.** A 404 from the orchestrator
  comes back as `isError: true` with the orchestrator's own message
  (`Queue not found`), so the model reads and reacts instead of the client
  aborting the call.
- **stdout is protocol-only.** Diagnostics go to stderr, which the client shows
  as server logs. A stray `console.log` on stdout corrupts the frame stream.
- **Ordered responses.** Requests are answered in arrival order, so a slow tool
  never lets a later one overtake it. Clients tolerate out-of-order responses;
  ordered output just makes transcripts readable.

Covered by `tests/unit/mcp/` (protocol, tools, HTTP transport, stdio framing) at
the repository's 100% gate.
