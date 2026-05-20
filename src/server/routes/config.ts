import { Router, Request, Response } from 'express';
import { ConfigManager } from '../services/config-manager.js';

const router = Router();

// Public-safe LSS configuration snapshot for the UI overview.
// Never expose the LocalStack auth token — only whether it's set.
router.get('/', (_req: Request, res: Response) => {
  const cm = ConfigManager.getInstance();
  res.json({
    serverPort: cm.getServerPort(),
    localstack: {
      mode: cm.getMode(),
      endpoint: cm.getLocalStackEndpoint(),
      port: cm.getLocalStackPort(),
      edition: cm.getLocalStackEdition(),
      version: cm.getLocalStackVersion(),
      image: cm.getLocalStackImage(),
      hasAuthToken: Boolean(cm.getLocalStackAuthToken()),
    },
    dynamoProxy: {
      enabled: cm.isEnableDynamoProxy(),
      port: cm.getDynamoProxyPort(),
    },
    region: cm.getRegion(),
    services: cm.getServices(),
    persistence: cm.isPersistence(),
    debug: cm.isDebug(),
    seedsDir: cm.getSeedsDir(),
    autoPackage: cm.isAutoPackage(),
    packageCommand: cm.getPackageCommand(),
    packageTimeoutMs: cm.getPackageTimeoutMs(),
    configPath: cm.getConfigPath(),
  });
});

export { router as configRouter };
