// STS stub (Query protocol) — GetCallerIdentity only, per PRD §RF2.5: many
// application bootstraps call it before anything else and fail confusingly
// without it. Everything else is explicitly not implemented.

import { randomUUID } from 'crypto';
import type { AwsRequest, EngineContext, EngineServiceName, QueryEmulator } from '../types.js';
import { notImplementedOperation } from '../http/errors.js';
import { tag, xmlDocument } from '../http/xml.js';

const STS_XMLNS = 'https://sts.amazonaws.com/doc/2011-06-15/';

export class StsEmulator implements QueryEmulator {
  readonly service: EngineServiceName = 'sts';

  private ctx: EngineContext;

  constructor(ctx: EngineContext) {
    this.ctx = ctx;
  }

  async handle(action: string, _params: Record<string, string>, _req: AwsRequest): Promise<string> {
    if (action !== 'GetCallerIdentity') throw notImplementedOperation('sts', action);
    const account = this.ctx.config.account;
    const result = tag(
      'GetCallerIdentityResult',
      tag('Arn', `arn:aws:iam::${account}:root`) + tag('UserId', account) + tag('Account', account),
      { escape: false },
    );
    const metadata = tag('ResponseMetadata', tag('RequestId', randomUUID()), { escape: false });
    return xmlDocument(
      tag('GetCallerIdentityResponse', result + metadata, { attrs: { xmlns: STS_XMLNS }, escape: false }),
    );
  }
}
