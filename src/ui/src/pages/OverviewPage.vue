<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import {
  TCard, TStack, TBadge, TGrid, TStat, TTag, TDivider, TButton, TSpinner, TText, TIcon,
  TDescriptionList, TDescriptionItem,
} from '@treeui/vue';
import { RouterLink } from 'vue-router';
import { api } from '../services/api';
import type {
  HealthInfo, LambdaSummary, LssConfigSnapshot, PortEntry, ServiceApiInfo, ServiceSummary,
} from '../services/api';

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
const localstackTone = computed(() => health.value?.localstack ? 'success' : 'danger');
const proxyEnabled = computed(() => Boolean(health.value?.dynamoProxy?.enabled));
const proxyRunning = computed(() => Boolean(health.value?.dynamoProxy?.running));
const autoPackage = computed(() => Boolean(config.value?.autoPackage));
const persistence = computed(() => Boolean(config.value?.persistence));

const portKindTone: Record<PortEntry['kind'], 'info' | 'success' | 'warning' | 'neutral'> = {
  orchestrator: 'info',
  engine: 'success',
  sidecar: 'info',
  proxy: 'warning',
  'service-api': 'info',
  'service-invoke': 'neutral',
};
const portKindLabel: Record<PortEntry['kind'], string> = {
  orchestrator: 'orchestrator',
  engine: 'engine',
  sidecar: 'sidecar',
  proxy: 'proxy',
  'service-api': 'HTTP API',
  'service-invoke': 'invoke',
};

const coveredResources = [
  {
    type: 'SNS Topics',
    description: 'Pub/sub fan-out for cross-service events',
    status: 'covered' as const,
    to: null,
  },
  {
    type: 'SQS Queues',
    description: 'Async message queues with consumer monitoring',
    status: 'covered' as const,
    to: '/queues',
  },
  {
    type: 'DynamoDB Tables',
    description: 'Tables, indexes, items explorer and seeds',
    status: 'covered' as const,
    to: '/dynamo',
  },
  {
    type: 'S3 Buckets',
    description: 'Buckets, objects browser, upload/download, Lambda notifications',
    status: 'covered' as const,
    to: '/buckets',
  },
];

onMounted(() => {
  loadAll();
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
            <TText tone="muted">One LocalStack. Every microservice. Zero docker juggling.</TText>
          </TStack>
        </TStack>
        <p style="max-width: 70ch; line-height: 1.55;">
          A single control plane for your local serverless workflow. Register a Serverless Framework project
          and LSS parses its CloudFormation template, provisions the resources in a shared LocalStack
          instance, wires up event-source mappings, and gives you live visibility into every queue, table,
          and topic — without spinning up a separate LocalStack per service.
        </p>
        <TStack direction="horizontal" gap="0.5rem" wrap>
          <TBadge :tone="localstackTone" variant="soft">
            LocalStack {{ health?.localstack ? 'running' : 'offline' }}
          </TBadge>
          <TBadge
            v-if="proxyEnabled"
            :tone="proxyRunning ? 'success' : 'warning'"
            variant="soft"
          >
            Dynamo Proxy {{ proxyRunning ? 'on' : 'enabled (not listening)' }}
          </TBadge>
          <TBadge v-else tone="neutral" variant="soft">Dynamo Proxy off</TBadge>
          <TBadge :tone="autoPackage ? 'info' : 'neutral'" variant="soft">
            Auto-package {{ autoPackage ? 'on' : 'off' }}
          </TBadge>
          <TBadge :tone="persistence ? 'info' : 'neutral'" variant="soft">
            Persistence {{ persistence ? 'on' : 'off' }}
          </TBadge>
        </TStack>
      </TStack>
    </TCard>

    <TStack v-if="loading && !health" direction="horizontal" justify="center" align="center">
      <TSpinner label="Loading overview..." />
    </TStack>

    <template v-else>
      <!-- Status + Config side by side -->
      <TGrid :columns="2" gap="1rem">
        <TCard variant="outline">
          <template #header>
            <TText weight="semibold">Server status</TText>
          </template>
          <TDescriptionList>
            <TDescriptionItem label="LocalStack">
              <TBadge :tone="health?.localstack ? 'success' : 'danger'" variant="soft">
                {{ health?.localstack ? 'Running' : 'Offline' }}
              </TBadge>
            </TDescriptionItem>
            <TDescriptionItem label="Endpoint">
              <TText family="mono">{{ config?.localstack?.endpoint || '—' }}</TText>
            </TDescriptionItem>
            <TDescriptionItem label="Image">
              <TText family="mono" size="sm">{{ config?.localstack?.image || '—' }}</TText>
            </TDescriptionItem>
            <TDescriptionItem label="Mode">
              <TTag size="sm" variant="soft">{{ config?.localstack?.mode || '—' }}</TTag>
            </TDescriptionItem>
          </TDescriptionList>
          <TDivider />
          <TDescriptionList>
            <TDescriptionItem label="Dynamo Proxy">
              <TStack direction="horizontal" gap="0.375rem" align="center">
                <TBadge
                  v-if="proxyEnabled"
                  :tone="proxyRunning ? 'success' : 'warning'"
                  variant="soft"
                >
                  {{ proxyRunning ? `Listening :${health?.dynamoProxy?.port}` : 'Enabled, not listening' }}
                </TBadge>
                <TBadge v-else tone="neutral" variant="soft">Disabled</TBadge>
              </TStack>
            </TDescriptionItem>
            <TDescriptionItem label="Auto-package">
              <TBadge :tone="autoPackage ? 'info' : 'neutral'" variant="soft">
                {{ autoPackage ? 'on' : 'off' }}
              </TBadge>
            </TDescriptionItem>
            <TDescriptionItem label="Persistence">
              <TBadge :tone="persistence ? 'info' : 'neutral'" variant="soft">
                {{ persistence ? 'on' : 'off' }}
              </TBadge>
            </TDescriptionItem>
          </TDescriptionList>
        </TCard>

        <TCard variant="outline">
          <template #header>
            <TStack direction="horizontal" justify="space-between" align="center">
              <TText weight="semibold">LSS configuration</TText>
              <RouterLink to="/settings" style="text-decoration: none;">
                <TButton size="sm" variant="ghost">Edit <TIcon name="arrow-right" /></TButton>
              </RouterLink>
            </TStack>
          </template>
          <TDescriptionList>
            <TDescriptionItem label="Engine">
              <TTag size="sm" variant="soft">{{ config?.engine?.kind || '—' }}</TTag>
            </TDescriptionItem>
            <TDescriptionItem label="Default region">
              <TText family="mono">{{ config?.region || '—' }}</TText>
            </TDescriptionItem>
            <TDescriptionItem label="Server port">
              <TText family="mono">{{ config?.serverPort || '—' }}</TText>
            </TDescriptionItem>
            <TDescriptionItem label="LocalStack services">
              <TStack direction="horizontal" gap="0.25rem" wrap justify="flex-end">
                <TTag
                  v-for="svc in (config?.services || [])"
                  :key="svc"
                  size="sm"
                  variant="soft"
                >
                  {{ svc }}
                </TTag>
                <TText v-if="!(config?.services || []).length" tone="muted">—</TText>
              </TStack>
            </TDescriptionItem>
            <TDescriptionItem label="Seeds dir">
              <TText family="mono" size="xs">{{ config?.seedsDir || '—' }}</TText>
            </TDescriptionItem>
            <TDescriptionItem v-if="config?.configPath" label="Config file">
              <TText family="mono" size="xs">{{ config.configPath }}</TText>
            </TDescriptionItem>
          </TDescriptionList>
        </TCard>
      </TGrid>

      <!-- Every local port the stack exposes -->
      <TCard variant="outline">
        <template #header>
          <TStack direction="horizontal" justify="space-between" align="center">
            <TText weight="semibold">Exposed ports</TText>
            <TText tone="muted" size="xs">
              What to point your SDKs, curl and browser at
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
              <TBadge :tone="portKindTone[entry.kind]" variant="soft">{{ portKindLabel[entry.kind] }}</TBadge>
              <TText family="mono" size="sm">{{ entry.url }}</TText>
            </TStack>
          </TDescriptionItem>
        </TDescriptionList>
        <TText v-else tone="muted" size="sm">No ports reported — is the orchestrator healthy?</TText>
      </TCard>

      <!-- Totalizers -->
      <TGrid :columns="5" gap="1rem">
        <TStat
          label="Services running"
          :value="`${runningServices} / ${totalServices}`"
          tone="success"
        />
        <TStat
          label="Lambdas online"
          :value="`${lambdasOnline} / ${totalLambdas}`"
          tone="success"
        />
        <TStat
          label="API routes"
          :value="apiRoutesTotal"
          tone="info"
        />
        <TStat
          label="DynamoDB tables"
          :value="resources.tables.length"
          tone="info"
        />
        <TStat
          label="SQS queues"
          :value="resources.queues.length"
          tone="warning"
        />
        <TStat
          label="SNS topics"
          :value="resources.topics.length"
          tone="info"
        />
        <TStat
          label="S3 buckets"
          :value="resources.buckets.length"
          tone="neutral"
        />
        <TStat
          label="OpenSearch collections"
          :value="resources.collections?.length ?? 0"
          tone="info"
        />
      </TGrid>

      <!-- Coverage -->
      <TCard variant="outline">
        <template #header>
          <TStack direction="horizontal" justify="space-between" align="center">
            <TText weight="semibold">What's covered</TText>
            <TText tone="muted" size="xs">
              Resource types LSS understands today
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
                <TStack direction="horizontal" gap="0.5rem" align="center">
                  <TIcon :name="item.status === 'covered' ? 'check' : 'clock'" />
                  <TText weight="semibold">{{ item.type }}</TText>
                  <TBadge
                    :tone="item.status === 'covered' ? 'success' : 'neutral'"
                    variant="soft"
                  >
                    {{ item.status === 'covered' ? 'Supported' : 'Planned' }}
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
                <TButton size="sm" variant="ghost">Open <TIcon name="arrow-right" /></TButton>
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
