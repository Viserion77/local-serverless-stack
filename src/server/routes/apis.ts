import { Router, Request, Response } from 'express';
import { FunctionRegistry } from '../services/function-registry.js';
import { GatewayManager } from '../services/gateway-manager.js';
import { AuthorizerService } from '../services/authorizer-service.js';

const router = Router();

// Registered HTTP routes grouped by service, with the gateway listener status.
router.get('/', (_req: Request, res: Response) => {
  const registry = FunctionRegistry.getInstance();
  const gateway = GatewayManager.getInstance();

  const services = registry.listServices()
    .filter(s => s.routes.length > 0 || s.apiPort)
    .map(service => {
      const info = gateway.getInfo(service.name);
      return {
        service: service.name,
        apiPort: service.apiPort,
        invokePort: service.invokePort,
        stage: service.stage,
        status: info.api.status,
        invokeStatus: info.invoke.status,
        routes: service.routes.map(route => ({
          method: route.method,
          path: route.path,
          functionName: route.functionName,
          // Cross-service / raw-CFN target ARN (undefined for local state routes).
          functionArn: route.functionArn,
          eventType: route.eventType,
          payloadVersion: route.eventType === 'httpApi' ? '2.0' : '1.0',
          cors: route.cors,
          authorizerName: route.authorizerName,
          // True when sourced from raw AWS::ApiGatewayV2 resources.
          raw: route.raw,
        })),
        authorizers: service.authorizers.map(a => ({
          name: a.name,
          type: a.type,
          eventType: a.eventType,
          payloadVersion: a.payloadVersion,
          enableSimpleResponses: a.enableSimpleResponses,
          identitySource: a.identitySource,
          resultTtlInSeconds: a.resultTtlInSeconds,
          functionName: a.functionName,
          arn: a.arn,
        })),
      };
    });

  return res.json(services);
});

// Flush the authorizer result cache — essential for e2e flows that switch
// identities without waiting out resultTtlInSeconds.
router.post('/authorizer-cache/clear', (req: Request, res: Response) => {
  const service = typeof req.query.service === 'string' ? req.query.service : undefined;
  const authorizer = typeof req.query.authorizer === 'string' ? req.query.authorizer : undefined;
  const removed = AuthorizerService.getInstance().clearCache({ service, authorizer });
  return res.json({ success: true, removed });
});

export { router as apisRouter };
