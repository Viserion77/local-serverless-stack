<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import {
  TCard, TStack, TBadge, TGrid, TStat, TTag, TDivider, TButton, TSpinner, TText, TIcon,
  TDescriptionList, TDescriptionItem,
} from '@treeui/vue';
import { RouterLink } from 'vue-router';
import ActivityPanel from '../components/ActivityPanel.vue';
import { api } from '../services/api';
import { isOnboardingDone } from '../services/onboarding';
import { useI18n } from '../i18n';
import type { AwsIconName } from '../icons/aws';
import { engineServiceIcon } from '../icons/resourceIcons';
import type {
  HealthInfo, LambdaSummary, LssConfigSnapshot, PortEntry, ServiceApiInfo, ServiceSummary,
} from '../services/api';

const { t } = useI18n();
const router = useRouter();
const health = ref<HealthInfo | null>(null);
const config = ref<LssConfigSnapshot | null>(null);
const ports = ref<PortEntry[]>([]);
const services = ref<ServiceSummary[]>([]);
const lambdas = ref<LambdaSummary[]>([]);
const apis = ref<ServiceApiInfo[]>([]);
const resources = ref<{ tables: string[]; queues: string[]; topics: string[]; buckets: string[]; collections?: string[] }>({
  tables: [],
  queues: [],
  topics: [],
  buckets: [],
  collections: [],
});
const loading = ref(true);
let timer: number | null = null;

async function loadAll() {
  try {
    const [h, c, s, r, l, a, p] = await Promise.all([
      api.checkHealth(),
      api.getConfig(),
      api.listServices(),
      api.listResources(),
      api.listLambdas().catch(() => [] as LambdaSummary[]),
      api.listApis().catch(() => [] as ServiceApiInfo[]),
      api.getPorts().catch(() => ({ ports: [] as PortEntry[] })),
    ]);
    health.value = h;
    config.value = c;
    services.value = s;
    resources.value = r;
    lambdas.value = l;
    apis.value = a;
    ports.value = p.ports;
  } catch (error) {
    console.error('Overview load failed:', error);
  } finally {
    loading.value = false;
  }
}

const runningServices = computed(() => services.value.filter(s => s.status === 'running').length);
const totalServices = computed(() => services.value.length);
const lambdasOnline = computed(() => lambdas.value.filter(l => l.status === 'online').length);
const totalLambdas = computed(() => lambdas.value.length);
const apiRoutesTotal = computed(() => apis.value.reduce((s, a) => s + a.routes.length, 0));
const engineRunning = computed(() => health.value?.engineRunning ?? false);
const engineTone = computed(() => (engineRunning.value ? 'success' : 'danger'));
// What the engine reports it answers for — the truth, rather than a configured
// wish list (v1 read it from a configured service allow-list).
const emulatedServices = computed(() => health.value?.engine?.services ?? []);

// The engine reports raw wire ids ('aoss', 'events'), which read as jargon on
// their own — each one names one AWS service, so each tag carries that
// service's official mark. The id → mark table lives in `icons/resourceIcons`
// with the other service→mark decisions, and is exhaustive over the engine's
// service union; `engineServiceIcon` returns null for an id from a newer
// orchestrator, so it renders as text rather than under a wrong brand.
//
// Resolved here rather than in the template so the `null` case is a value the
// template can branch on, instead of an index expression typed as if it always
// hits.
const emulatedServiceTags = computed(() => emulatedServices.value.map(id => ({
  id,
  icon: engineServiceIcon(id),
})));
const proxyEnabled = computed(() => Boolean(health.value?.dynamoProxy?.enabled));
const proxyRunning = computed(() => Boolean(health.value?.dynamoProxy?.running));
const autoPackage = computed(() => Boolean(config.value?.autoPackage));
const persistence = computed(() => Boolean(config.value?.persistence));

const portKindTone: Record<PortEntry['kind'], 'info' | 'success' | 'warning' | 'neutral'> = {
  orchestrator: 'info',
  engine: 'success',
  proxy: 'warning',
  'service-api': 'info',
  'service-invoke': 'neutral',
};
// Only the message *keys* live at module level: the label itself has to be
// resolved on every render, otherwise a language switch would leave the badges
// in the old locale.
const portKindKeys: Record<PortEntry['kind'], string> = {
  orchestrator: 'overview.portKindOrchestrator',
  engine: 'overview.portKindEngine',
  proxy: 'overview.portKindProxy',
  'service-api': 'overview.portKindServiceApi',
  'service-invoke': 'overview.portKindServiceInvoke',
};
function portKindLabel(kind: PortEntry['kind']): string {
  return t(portKindKeys[kind]);
}

/**
 * One row of the coverage card.
 *
 * `icon` and `status` answer two different questions and must stay separate:
 * the brand says WHICH AWS service the row is about, the status says whether
 * LSS covers it yet. Annotating the computed is what keeps `icon` a registered
 * icon name — an inferred object literal would widen it to `string`, which
 * `TIcon`'s `name` does not accept.
 */
interface CoveredResource {
  type: string;
  description: string;
  status: 'covered' | 'planned';
  to: string | null;
  icon: AwsIconName;
}

// Computed (not a plain const) for the same reason: t() must run per render.
const coveredResources = computed<CoveredResource[]>(() => [
  {
    type: t('overview.coveredSnsTitle'),
    description: t('overview.coveredSnsDescription'),
    status: 'covered',
    to: null,
    icon: 'aws-sns',
  },
  {
    type: t('overview.coveredSqsTitle'),
    description: t('overview.coveredSqsDescription'),
    status: 'covered',
    to: '/queues',
    icon: 'aws-sqs',
  },
  {
    type: t('overview.coveredDynamoTitle'),
    description: t('overview.coveredDynamoDescription'),
    status: 'covered',
    to: '/dynamo',
    icon: 'aws-dynamodb',
  },
  {
    type: t('overview.coveredS3Title'),
    description: t('overview.coveredS3Description'),
    status: 'covered',
    to: '/buckets',
    icon: 'aws-s3',
  },
]);

onMounted(async () => {
  await loadAll();
  // A stack with nothing registered and no dismissed flag is a first run —
  // hand the user to the guided setup instead of an empty dashboard.
  if (services.value.length === 0 && !isOnboardingDone()) {
    void router.push('/onboarding');
    return;
  }
  timer = window.setInterval(loadAll, 15000);
});

onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer);
});
</script>

<template>
  <TStack direction="vertical" gap="1.5rem">
    <!-- Hero -->
    <TCard variant="outline" class="overview-hero">
      <TStack direction="vertical" gap="1rem">
        <TStack direction="horizontal" gap="0.75rem" align="center" wrap>
          <TIcon name="zap" />
          <TStack direction="vertical" gap="0.125rem">
            <TText size="xl" weight="semibold">Local Serverless Stack</TText>
            <TText tone="muted">{{ t('overview.heroTagline') }}</TText>
          </TStack>
        </TStack>
        <p style="max-width: 70ch; line-height: 1.55;">
          {{ t('overview.heroParagraph') }}
        </p>
        <TStack direction="horizontal" gap="0.5rem" wrap>
          <TBadge :tone="engineTone" variant="soft">
            {{ engineRunning ? t('overview.engineBadgeRunning') : t('overview.engineBadgeOffline') }}
          </TBadge>
          <TBadge
            v-if="proxyEnabled"
            :tone="proxyRunning ? 'success' : 'warning'"
            variant="soft"
          >
            {{ proxyRunning ? t('overview.proxyBadgeOn') : t('overview.proxyBadgeNotListening') }}
          </TBadge>
          <TBadge v-else tone="neutral" variant="soft">{{ t('overview.proxyBadgeOff') }}</TBadge>
          <TBadge :tone="autoPackage ? 'info' : 'neutral'" variant="soft">
            {{ t('overview.autoPackage') }} {{ autoPackage ? t('overview.on') : t('overview.off') }}
          </TBadge>
          <TBadge :tone="persistence ? 'info' : 'neutral'" variant="soft">
            {{ t('overview.persistence') }} {{ persistence ? t('overview.on') : t('overview.off') }}
          </TBadge>
        </TStack>
      </TStack>
    </TCard>

    <ActivityPanel />

    <TStack v-if="loading && !health" direction="horizontal" justify="center" align="center">
      <TSpinner :label="t('overview.loading')" />
    </TStack>

    <template v-else>
      <!-- Status + Config side by side -->
      <TGrid :columns="2" gap="1rem">
        <TCard variant="outline">
          <template #header>
            <TText weight="semibold">{{ t('overview.serverStatus') }}</TText>
          </template>
          <TDescriptionList>
            <TDescriptionItem :label="t('overview.selfEngine')">
              <TBadge :tone="engineTone" variant="soft">
                {{ engineRunning ? t('overview.running') : t('overview.offline') }}
              </TBadge>
            </TDescriptionItem>
            <TDescriptionItem :label="t('overview.endpoint')">
              <TText family="mono">{{ config?.engine?.endpoint || '—' }}</TText>
            </TDescriptionItem>
            <TDescriptionItem :label="t('overview.runsIn')">
              <TTag size="sm" variant="soft">{{ t('overview.runsInValue') }}</TTag>
            </TDescriptionItem>
          </TDescriptionList>
          <TDivider />
          <TDescriptionList>
            <TDescriptionItem :label="t('overview.dynamoProxy')">
              <TStack direction="horizontal" gap="0.375rem" align="center">
                <TBadge
                  v-if="proxyEnabled"
                  :tone="proxyRunning ? 'success' : 'warning'"
                  variant="soft"
                >
                  {{ proxyRunning
                    ? t('overview.proxyListening', { port: health?.dynamoProxy?.port ?? '' })
                    : t('overview.proxyEnabledNotListening') }}
                </TBadge>
                <TBadge v-else tone="neutral" variant="soft">{{ t('common.disabled') }}</TBadge>
              </TStack>
            </TDescriptionItem>
            <TDescriptionItem :label="t('overview.autoPackage')">
              <TBadge :tone="autoPackage ? 'info' : 'neutral'" variant="soft">
                {{ autoPackage ? t('overview.on') : t('overview.off') }}
              </TBadge>
            </TDescriptionItem>
            <TDescriptionItem :label="t('overview.persistence')">
              <TBadge :tone="persistence ? 'info' : 'neutral'" variant="soft">
                {{ persistence ? t('overview.on') : t('overview.off') }}
              </TBadge>
            </TDescriptionItem>
          </TDescriptionList>
        </TCard>

        <TCard variant="outline">
          <template #header>
            <TStack direction="horizontal" justify="space-between" align="center">
              <TText weight="semibold">{{ t('overview.lssConfiguration') }}</TText>
              <RouterLink to="/settings" style="text-decoration: none;">
                <TButton size="sm" variant="ghost">{{ t('overview.edit') }} <TIcon name="arrow-right" /></TButton>
              </RouterLink>
            </TStack>
          </template>
          <TDescriptionList>
            <TDescriptionItem :label="t('overview.engine')">
              <TTag size="sm" variant="soft">{{ config?.engine?.kind || '—' }}</TTag>
            </TDescriptionItem>
            <TDescriptionItem :label="t('overview.defaultRegion')">
              <TText family="mono">{{ config?.region || '—' }}</TText>
            </TDescriptionItem>
            <TDescriptionItem :label="t('overview.serverPort')">
              <TText family="mono">{{ config?.serverPort || '—' }}</TText>
            </TDescriptionItem>
            <TDescriptionItem :label="t('overview.emulatedServices')">
              <TStack direction="horizontal" gap="0.25rem" wrap justify="flex-end">
                <!-- The mark is decorative: the id beside it already is the tag's
                     accessible name, and 'aoss'/'sts' are exactly the labels a
                     screen reader should read out here. The v-if sits on the
                     slot rather than on the TIcon because TTag renders its icon
                     frame from `$slots.icon` alone — an always-declared slot
                     would leave an empty frame (and its gap) on an unmapped id. -->
                <TTag v-for="svc in emulatedServiceTags" :key="svc.id" size="sm" variant="soft">
                  <template
                    v-if="svc.icon"
                    #icon
                  >
                    <TIcon :name="svc.icon" />
                  </template>
                  {{ svc.id }}
                </TTag>
                <TText v-if="!emulatedServiceTags.length" tone="muted">—</TText>
              </TStack>
            </TDescriptionItem>
            <TDescriptionItem :label="t('overview.seedsDir')">
              <TText family="mono" size="xs">{{ config?.seedsDir || '—' }}</TText>
            </TDescriptionItem>
            <TDescriptionItem v-if="config?.configPath" :label="t('overview.configFile')">
              <TText family="mono" size="xs">{{ config.configPath }}</TText>
            </TDescriptionItem>
          </TDescriptionList>
        </TCard>
      </TGrid>

      <!-- Every local port the stack exposes -->
      <TCard variant="outline">
        <template #header>
          <TStack direction="horizontal" justify="space-between" align="center">
            <TText weight="semibold">{{ t('overview.exposedPorts') }}</TText>
            <TText tone="muted" size="xs">
              {{ t('overview.exposedPortsHint') }}
            </TText>
          </TStack>
        </template>
        <TDescriptionList v-if="ports.length">
          <TDescriptionItem
            v-for="entry in ports"
            :key="`${entry.kind}-${entry.name}-${entry.port}`"
            :label="entry.name"
          >
            <TStack direction="horizontal" gap="0.5rem" align="center" wrap justify="flex-end">
              <TText tone="muted" size="xs">{{ entry.description }}</TText>
              <TBadge :tone="portKindTone[entry.kind]" variant="soft">{{ portKindLabel(entry.kind) }}</TBadge>
              <TText family="mono" size="sm">{{ entry.url }}</TText>
            </TStack>
          </TDescriptionItem>
        </TDescriptionList>
        <TText v-else tone="muted" size="sm">{{ t('overview.noPorts') }}</TText>
      </TCard>

      <!-- Totalizers. Each tile counts one thing, so each carries that thing's
           mark in TStat's #icon slot: the seven AWS resource counters get the
           official service icon, and "services running" — which counts
           LSS-registered microservices, not an AWS service — gets the same
           TreeUI functional icon the sidebar uses for that concept. Every
           label already names what it counts, so the marks stay decorative. -->
      <TGrid :columns="5" gap="1rem">
        <TStat
          :label="t('overview.statServicesRunning')"
          :value="`${runningServices} / ${totalServices}`"
          tone="success"
        >
          <template #icon>
            <TIcon name="boxes" />
          </template>
        </TStat>
        <TStat
          :label="t('overview.statLambdasOnline')"
          :value="`${lambdasOnline} / ${totalLambdas}`"
          tone="success"
        >
          <template #icon>
            <TIcon name="aws-lambda" />
          </template>
        </TStat>
        <TStat
          :label="t('overview.statApiRoutes')"
          :value="apiRoutesTotal"
          tone="info"
        >
          <template #icon>
            <TIcon name="aws-api-gateway" />
          </template>
        </TStat>
        <TStat
          :label="t('overview.statDynamoTables')"
          :value="resources.tables.length"
          tone="info"
        >
          <template #icon>
            <TIcon name="aws-dynamodb" />
          </template>
        </TStat>
        <TStat
          :label="t('overview.statSqsQueues')"
          :value="resources.queues.length"
          tone="warning"
        >
          <template #icon>
            <TIcon name="aws-sqs" />
          </template>
        </TStat>
        <TStat
          :label="t('overview.statSnsTopics')"
          :value="resources.topics.length"
          tone="info"
        >
          <template #icon>
            <TIcon name="aws-sns" />
          </template>
        </TStat>
        <TStat
          :label="t('overview.statS3Buckets')"
          :value="resources.buckets.length"
          tone="neutral"
        >
          <template #icon>
            <TIcon name="aws-s3" />
          </template>
        </TStat>
        <TStat
          :label="t('overview.statOpenSearchCollections')"
          :value="resources.collections?.length ?? 0"
          tone="info"
        >
          <template #icon>
            <TIcon name="aws-opensearch" />
          </template>
        </TStat>
      </TGrid>

      <!-- Coverage -->
      <TCard variant="outline">
        <template #header>
          <TStack direction="horizontal" justify="space-between" align="center">
            <TText weight="semibold">{{ t('overview.whatsCovered') }}</TText>
            <TText tone="muted" size="xs">
              {{ t('overview.whatsCoveredHint') }}
            </TText>
          </TStack>
        </template>
        <TGrid :columns="2" gap="0.75rem">
          <TCard
            v-for="item in coveredResources"
            :key="item.type"
            variant="soft"
          >
            <TStack direction="horizontal" gap="0.75rem" align="center" justify="space-between">
              <TStack direction="vertical" gap="0.125rem">
                <!-- Two marks, two meanings: the AWS brand leads because it says
                     WHICH service the row is about, and check/clock stays a
                     TreeUI functional icon because it says supported vs planned.
                     Moving that one into the badge's #icon slot keeps it next to
                     the words it qualifies instead of competing with the brand
                     for the leading position. -->
                <TStack direction="horizontal" gap="0.5rem" align="center">
                  <TIcon :name="item.icon" />
                  <TText weight="semibold">{{ item.type }}</TText>
                  <TBadge
                    :tone="item.status === 'covered' ? 'success' : 'neutral'"
                    variant="soft"
                  >
                    <template #icon>
                      <TIcon :name="item.status === 'covered' ? 'check' : 'clock'" />
                    </template>
                    {{ item.status === 'covered' ? t('overview.supported') : t('overview.planned') }}
                  </TBadge>
                </TStack>
                <TText tone="muted" size="sm">
                  {{ item.description }}
                </TText>
              </TStack>
              <RouterLink
                v-if="item.to"
                :to="item.to"
                style="text-decoration: none;"
              >
                <TButton size="sm" variant="ghost">{{ t('overview.open') }} <TIcon name="arrow-right" /></TButton>
              </RouterLink>
            </TStack>
          </TCard>
        </TGrid>
      </TCard>
    </template>
  </TStack>
</template>

<style scoped>
.overview-hero {
  background: linear-gradient(
    135deg,
    var(--tree-color-bg-surface, rgba(255, 255, 255, 0.02)),
    transparent
  );
}
</style>
