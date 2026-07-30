// One place that pins the default AWS region on every explorer/inspector.
//
// The explorers all accept an optional `?region=` and fall back to a default.
// The dashboard always sends one (it reads the region from /api/config), so a
// wrong default stayed invisible there — but the CLI, the LssClient and a bare
// curl all omit it, and a project on any region other than us-east-1 got empty
// lists back. Boot calls this with the configured region; keeping it in a
// single module means a new explorer is one line away from being covered.

import { DynamoExplorer } from './dynamo-explorer.js';
import { S3Explorer } from './s3-explorer.js';
import { SecretsExplorer } from './secrets-explorer.js';
import { OpenSearchExplorer } from './opensearch-explorer.js';
import { QueueInspector } from './queue-inspector.js';

export function applyRegionToExplorers(region: string): void {
  if (!region) return;
  DynamoExplorer.getInstance().setDefaultRegion(region);
  S3Explorer.getInstance().setDefaultRegion(region);
  SecretsExplorer.getInstance().setDefaultRegion(region);
  OpenSearchExplorer.getInstance().setDefaultRegion(region);
  QueueInspector.getInstance().setDefaultRegion(region);
}
