// applyRegionToExplorers pins the default region on every explorer/inspector.
// The dashboard always sends `?region=`, so a wrong default only ever hurt the
// callers that omit it (CLI, LssClient, curl) — this is the guard that keeps
// a newly added explorer from silently regressing to us-east-1.
import { applyRegionToExplorers } from '../../../src/server/services/explorer-region';
import { DynamoExplorer } from '../../../src/server/services/dynamo-explorer';
import { S3Explorer } from '../../../src/server/services/s3-explorer';
import { SecretsExplorer } from '../../../src/server/services/secrets-explorer';
import { OpenSearchExplorer } from '../../../src/server/services/opensearch-explorer';
import { QueueInspector } from '../../../src/server/services/queue-inspector';

const singletons = () => [
  DynamoExplorer.getInstance(),
  S3Explorer.getInstance(),
  SecretsExplorer.getInstance(),
  OpenSearchExplorer.getInstance(),
  QueueInspector.getInstance(),
];

beforeEach(() => {
  for (const s of singletons()) (s as any).defaultRegion = 'us-east-1';
});

describe('applyRegionToExplorers', () => {
  it('pins the region on every explorer and inspector', () => {
    applyRegionToExplorers('sa-east-1');
    for (const s of singletons()) {
      expect((s as any).defaultRegion).toBe('sa-east-1');
    }
  });

  it('is a no-op for an empty region (config without one keeps the default)', () => {
    applyRegionToExplorers('');
    for (const s of singletons()) {
      expect((s as any).defaultRegion).toBe('us-east-1');
    }
  });
});
