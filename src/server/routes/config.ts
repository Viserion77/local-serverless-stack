import { Router, Request, Response } from 'express';
import { ConfigManager, BrandingAssetKind } from '../services/config-manager.js';

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
    branding: cm.getBranding(),
  });
});

// Branding only — what the UI needs on boot (title, logo, theme colors).
router.get('/branding', (_req: Request, res: Response) => {
  res.json(ConfigManager.getInstance().getBranding());
});

// Serve logo/favicon files referenced by path in the config, so branding
// assets can live next to lss.config.json without a separate web server.
router.get('/branding/:asset(logo|favicon)', (req: Request, res: Response) => {
  const kind = req.params.asset as BrandingAssetKind;
  const file = ConfigManager.getInstance().getBrandingAssetFile(kind);
  if (!file) {
    res.status(404).json({ error: `No local ${kind} file configured` });
    return;
  }
  res.sendFile(file);
});

export { router as configRouter };
