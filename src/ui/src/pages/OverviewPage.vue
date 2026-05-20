<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import {
  TCard, TStack, TBadge, TGrid, TStat, TTag, TDivider, TButton, TSpinner,
} from '@treeui/vue';
import { RouterLink } from 'vue-router';
import { api } from '../services/api';
import type {
  HealthInfo, LssConfigSnapshot, ServiceSummary,
} from '../services/api';

const health = ref<HealthInfo | null>(null);
const config = ref<LssConfigSnapshot | null>(null);
const services = ref<ServiceSummary[]>([]);
const resources = ref<{ tables: string[]; queues: string[]; topics: string[] }>({
  tables: [],
  queues: [],
  topics: [],
});
const loading = ref(true);
let timer: number | null = null;

async function loadAll() {
  try {
    const [h, c, s, r] = await Promise.all([
      api.checkHealth(),
      api.getConfig(),
      api.listServices(),
      api.listResources(),
    ]);
    health.value = h;
    config.value = c;
    services.value = s;
    resources.value = r;
  } catch (error) {
    console.error('Overview load failed:', error);
  } finally {
    loading.value = false;
  }
}

const runningServices = computed(() => services.value.filter(s => s.status === 'running').length);
const totalServices = computed(() => services.value.length);
const localstackTone = computed(() => health.value?.localstack ? 'success' : 'danger');
const proxyEnabled = computed(() => Boolean(health.value?.dynamoProxy?.enabled));
const proxyRunning = computed(() => Boolean(health.value?.dynamoProxy?.running));
const autoPackage = computed(() => Boolean(config.value?.autoPackage));
const persistence = computed(() => Boolean(config.value?.persistence));

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
    description: 'Object storage browser',
    status: 'planned' as const,
    to: null,
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
          <span style="font-size: 1.75rem;">⚡</span>
          <TStack direction="vertical" gap="0.125rem">
            <strong style="font-size: 1.5rem;">Local Serverless Stack</strong>
            <span class="muted">One LocalStack. Every microservice. Zero docker juggling.</span>
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

    <div v-if="loading && !health" style="display: flex; justify-content: center; padding: 2rem;">
      <TSpinner label="Loading overview..." />
    </div>

    <template v-else>
      <!-- Status + Config side by side -->
      <TGrid :columns="2" gap="1rem">
        <TCard variant="outline">
          <template #header>
            <strong>Server status</strong>
          </template>
          <TStack direction="vertical" gap="0.75rem">
            <TStack direction="horizontal" justify="space-between" align="center">
              <span class="muted">LocalStack</span>
              <TBadge :tone="health?.localstack ? 'success' : 'danger'" variant="soft">
                {{ health?.localstack ? 'Running' : 'Offline' }}
              </TBadge>
            </TStack>
            <TStack direction="horizontal" justify="space-between" align="center">
              <span class="muted">Endpoint</span>
              <span class="mono">{{ config?.localstack?.endpoint || '—' }}</span>
            </TStack>
            <TStack direction="horizontal" justify="space-between" align="center">
              <span class="muted">Image</span>
              <span class="mono" style="font-size: 0.8rem;">{{ config?.localstack?.image || '—' }}</span>
            </TStack>
            <TStack direction="horizontal" justify="space-between" align="center">
              <span class="muted">Mode</span>
              <TTag size="sm" variant="soft">{{ config?.localstack?.mode || '—' }}</TTag>
            </TStack>
            <TDivider />
            <TStack direction="horizontal" justify="space-between" align="center">
              <span class="muted">Dynamo Proxy</span>
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
            </TStack>
            <TStack direction="horizontal" justify="space-between" align="center">
              <span class="muted">Auto-package</span>
              <TBadge :tone="autoPackage ? 'info' : 'neutral'" variant="soft">
                {{ autoPackage ? 'on' : 'off' }}
              </TBadge>
            </TStack>
            <TStack direction="horizontal" justify="space-between" align="center">
              <span class="muted">Persistence</span>
              <TBadge :tone="persistence ? 'info' : 'neutral'" variant="soft">
                {{ persistence ? 'on' : 'off' }}
              </TBadge>
            </TStack>
          </TStack>
        </TCard>

        <TCard variant="outline">
          <template #header>
            <strong>LESC configuration</strong>
          </template>
          <TStack direction="vertical" gap="0.75rem">
            <TStack direction="horizontal" justify="space-between" align="center">
              <span class="muted">Default region</span>
              <span class="mono">{{ config?.region || '—' }}</span>
            </TStack>
            <TStack direction="horizontal" justify="space-between" align="center">
              <span class="muted">Server port</span>
              <span class="mono">{{ config?.serverPort || '—' }}</span>
            </TStack>
            <TStack direction="horizontal" justify="space-between" align="start" wrap>
              <span class="muted">LocalStack services</span>
              <TStack direction="horizontal" gap="0.25rem" wrap justify="flex-end">
                <TTag
                  v-for="svc in (config?.services || [])"
                  :key="svc"
                  size="sm"
                  variant="soft"
                >
                  {{ svc }}
                </TTag>
                <span v-if="!(config?.services || []).length" class="muted">—</span>
              </TStack>
            </TStack>
            <TStack direction="horizontal" justify="space-between" align="center">
              <span class="muted">Seeds dir</span>
              <span class="mono" style="font-size: 0.75rem;">{{ config?.seedsDir || '—' }}</span>
            </TStack>
            <TStack
              v-if="config?.configPath"
              direction="horizontal"
              justify="space-between"
              align="center"
            >
              <span class="muted">Config file</span>
              <span class="mono" style="font-size: 0.75rem;">{{ config.configPath }}</span>
            </TStack>
          </TStack>
        </TCard>
      </TGrid>

      <!-- Totalizers -->
      <TGrid :columns="4" gap="1rem">
        <TStat
          label="Services running"
          :value="`${runningServices} / ${totalServices}`"
          tone="success"
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
      </TGrid>

      <!-- Coverage -->
      <TCard variant="outline">
        <template #header>
          <TStack direction="horizontal" justify="space-between" align="center">
            <strong>What's covered</strong>
            <span class="muted" style="font-size: 0.75rem;">
              Resource types LSS understands today
            </span>
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
                  <span style="font-size: 1.05rem;">
                    {{ item.status === 'covered' ? '✓' : '⏳' }}
                  </span>
                  <strong>{{ item.type }}</strong>
                  <TBadge
                    :tone="item.status === 'covered' ? 'success' : 'neutral'"
                    variant="soft"
                  >
                    {{ item.status === 'covered' ? 'Supported' : 'Planned' }}
                  </TBadge>
                </TStack>
                <span class="muted" style="font-size: 0.825rem;">
                  {{ item.description }}
                </span>
              </TStack>
              <RouterLink
                v-if="item.to"
                :to="item.to"
                style="text-decoration: none;"
              >
                <TButton size="sm" variant="ghost">Open →</TButton>
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
    var(--tree-color-background-elevated, rgba(255, 255, 255, 0.02)),
    transparent
  );
}
</style>
