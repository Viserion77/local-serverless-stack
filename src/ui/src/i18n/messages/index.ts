// Merges the per-area catalogues into one flat map per locale. Keys are
// namespaced by their file (`onboarding.title`), so an area owns its whole key
// space and files never collide.
import type { Locale } from '../index';
import { common } from './common';
import { activity } from './activity';
import { nav } from './nav';
import { onboarding } from './onboarding';
import { overview } from './overview';
import { services } from './services';
import { lambdas } from './lambdas';
import { apis } from './apis';
import { queues } from './queues';
import { dynamo } from './dynamo';
import { buckets } from './buckets';
import { opensearch } from './opensearch';
import { secrets } from './secrets';
import { settings } from './settings';

// One area's messages: the same key set in every language. Keeping the three
// side by side is what makes a missing translation visible in review.
export type Catalogue = Record<string, string>;
export type AreaMessages = Record<Locale, Catalogue>;

const AREAS: Record<string, AreaMessages> = {
  common,
  activity,
  nav,
  onboarding,
  overview,
  services,
  lambdas,
  apis,
  queues,
  dynamo,
  buckets,
  opensearch,
  secrets,
  settings,
};

function flatten(locale: Locale): Catalogue {
  const flat: Catalogue = {};
  for (const [area, messages] of Object.entries(AREAS)) {
    for (const [key, value] of Object.entries(messages[locale] ?? {})) {
      flat[`${area}.${key}`] = value;
    }
  }
  return flat;
}

export const MESSAGES: Record<Locale, Catalogue> = {
  en: flatten('en'),
  'pt-BR': flatten('pt-BR'),
  es: flatten('es'),
};
