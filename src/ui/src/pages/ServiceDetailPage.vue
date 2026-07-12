<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import {
  TCard, TButton, TBadge, TStack, TGrid, TStat, TSpinner, TAlert,
  TTag, TEmptyState, TModal, TConfirmDialog, useToast,
} from '@treeui/vue';
import type { TreeBadgeTone } from '@treeui/vue';
import { api } from '../services/api';
import type { ServiceDetail, ServiceResource } from '../services/api';

const props = defineProps<{ serviceName: string }>();
const router = useRouter();
const toast = useToast();

const service = ref<ServiceDetail | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const starting = ref(false);
const stopping = ref(false);
const logsOpen = ref(false);
const logs = ref<string[]>([]);
const logsStatus = ref<'running' | 'stopped' | 'failed'>('stopped');
let logTimer: number | null = null;
let refreshTimer: number | null = null;
const deleteDialogOpen = ref(false);

const grouped = computed(() => {
  const byType: Record<string, ServiceResource[]> = {
    lambda: [], dynamodb: [], sqs: [], sns: [], s3: [], eventbus: [], 'event-rule': [], opensearch: [], 'event-source': [],
  };
  for (const r of service.value?.resources || []) {
    if (!byType[r.type]) byType[r.type] = [];
    byType[r.type].push(r);
  }
  return byType;
});

async function load() {
  loading.value = true;
  try {
    service.value = await api.getService(props.serviceName);
    error.value = null;
  } catch (err: any) {
    error.value = err.message || 'Service not found';
    service.value = null;
  } finally {
    loading.value = false;
  }
}

async function startSvc() {
  if (starting.value) return;
  starting.value = true;
  try {
    await api.startService(props.serviceName);
    toast.add({ title: 'Service started', description: props.serviceName, variant: 'success' });
    await load();
  } catch (err: any) {
    toast.add({ title: 'Failed to start', description: err.message, variant: 'danger' });
  } finally {
    starting.value = false;
  }
}

async function stopSvc() {
  if (stopping.value) return;
  stopping.value = true;
  try {
    await api.stopService(props.serviceName);
    toast.add({ title: 'Service stopped', description: props.serviceName, variant: 'info' });
    await load();
  } catch (err: any) {
    toast.add({ title: 'Failed to stop', description: err.message, variant: 'danger' });
  } finally {
    stopping.value = false;
  }
}

async function fetchLogs() {
  try {
    const data = await api.getServiceLogs(props.serviceName);
    logs.value = data.logs || [];
    logsStatus.value = data.status || 'stopped';
  } catch (err) {
    console.error('Failed to fetch logs:', err);
  }
}

function openLogs() {
  logsOpen.value = true;
  fetchLogs();
  if (logTimer) window.clearInterval(logTimer);
  logTimer = window.setInterval(fetchLogs, 2000);
}

function closeLogs() {
  logsOpen.value = false;
  if (logTimer) window.clearInterval(logTimer);
  logTimer = null;
}

async function confirmDelete() {
  try {
    await api.deleteService(props.serviceName);
    toast.add({ title: 'Service deleted', description: props.serviceName, variant: 'info' });
    router.push('/services');
  } catch (err: any) {
    toast.add({ title: 'Failed to delete', description: err.message, variant: 'danger' });
  } finally {
    deleteDialogOpen.value = false;
  }
}

function statusTone(status?: string): TreeBadgeTone {
  switch (status) {
    case 'running': return 'success';
    case 'registered': return 'warning';
    case 'stopped': return 'neutral';
    default: return 'danger';
  }
}

function formatDate(ts?: number): string {
  return ts ? new Date(ts).toLocaleString() : '—';
}

onMounted(() => {
  load();
  refreshTimer = window.setInterval(load, 10000);
});

onBeforeUnmount(() => {
  if (refreshTimer) window.clearInterval(refreshTimer);
  if (logTimer) window.clearInterval(logTimer);
});

watch(() => props.serviceName, load);
</script>

<template>
  <TStack direction="vertical" gap="1.25rem">
    <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
      <TStack direction="horizontal" gap="0.5rem" align="center">
        <RouterLink to="/services" style="text-decoration: none;">
          <TButton size="sm" variant="ghost">← Services</TButton>
        </RouterLink>
        <strong style="font-size: 1.1rem;">{{ serviceName }}</strong>
        <TBadge v-if="service?.status" :tone="statusTone(service.status)" variant="soft">
          {{ service.status }}
        </TBadge>
      </TStack>
      <TStack direction="horizontal" gap="0.375rem">
        <TButton
          size="sm"
          variant="soft"
          :disabled="service?.status === 'running'"
          :loading="starting"
          @click="startSvc"
        >
          Start
        </TButton>
        <TButton
          size="sm"
          variant="soft"
          :disabled="service?.status !== 'running'"
          :loading="stopping"
          @click="stopSvc"
        >
          Stop
        </TButton>
        <TButton size="sm" variant="ghost" @click="openLogs">Logs</TButton>
        <TButton size="sm" variant="ghost" :loading="loading" @click="load">Refresh</TButton>
        <TButton size="sm" variant="danger" @click="deleteDialogOpen = true">Delete</TButton>
      </TStack>
    </TStack>

    <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
      {{ error }}
    </TAlert>

    <div v-if="loading && !service" style="display: flex; justify-content: center; padding: 2rem;">
      <TSpinner label="Loading service..." />
    </div>

    <template v-else-if="service">
      <TGrid :columns="5" gap="1rem">
        <TStat label="Lambdas" :value="grouped.lambda?.length || 0" tone="info" />
        <TStat label="Tables" :value="grouped.dynamodb?.length || 0" tone="info" />
        <TStat label="Queues" :value="grouped.sqs?.length || 0" tone="warning" />
        <TStat label="Topics" :value="grouped.sns?.length || 0" tone="info" />
        <TStat label="Buckets" :value="grouped.s3?.length || 0" tone="neutral" />
      </TGrid>

      <TCard variant="outline">
        <template #header>
          <strong>Metadata</strong>
        </template>
        <TStack direction="vertical" gap="0.5rem">
          <TStack direction="horizontal" justify="space-between">
            <span class="muted">Path</span>
            <span class="mono">{{ service.root }}</span>
          </TStack>
          <TStack direction="horizontal" justify="space-between">
            <span class="muted">Region</span>
            <span class="mono">{{ service.region || '—' }}</span>
          </TStack>
          <TStack direction="horizontal" justify="space-between">
            <span class="muted">Invoke port</span>
            <span class="mono">{{ service.invokePort ?? '—' }}</span>
          </TStack>
          <TStack direction="horizontal" justify="space-between">
            <span class="muted">PID</span>
            <span class="mono">{{ service.pid ?? '—' }}</span>
          </TStack>
          <TStack direction="horizontal" justify="space-between">
            <span class="muted">Last updated</span>
            <span>{{ formatDate(service.lastUpdated) }}</span>
          </TStack>
        </TStack>
      </TCard>

      <TCard variant="outline">
        <template #header>
          <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
            <strong>Declared resources</strong>
            <TBadge tone="neutral" variant="soft">
              {{ service.resources?.length || 0 }} total
            </TBadge>
          </TStack>
        </template>

        <TEmptyState
          v-if="!service.resources?.length"
          title="No resources declared"
          description="This service's CloudFormation template has no resources LSS understands yet."
        />

        <TStack v-else direction="vertical" gap="1rem">
          <TStack v-if="grouped.dynamodb?.length" direction="vertical" gap="0.5rem">
            <TStack direction="horizontal" gap="0.5rem" align="center">
              <TBadge tone="info" variant="soft">DynamoDB tables</TBadge>
              <span class="muted">{{ grouped.dynamodb.length }}</span>
            </TStack>
            <TStack direction="horizontal" gap="0.375rem" wrap>
              <RouterLink
                v-for="r in grouped.dynamodb"
                :key="`db-${r.name}`"
                :to="`/dynamo/${encodeURIComponent(r.name)}`"
                style="text-decoration: none;"
              >
                <TTag size="sm" variant="soft" clickable>{{ r.name }}</TTag>
              </RouterLink>
            </TStack>
          </TStack>

          <TStack v-if="grouped.sqs?.length" direction="vertical" gap="0.5rem">
            <TStack direction="horizontal" gap="0.5rem" align="center">
              <TBadge tone="warning" variant="soft">SQS queues</TBadge>
              <span class="muted">{{ grouped.sqs.length }}</span>
            </TStack>
            <TStack direction="horizontal" gap="0.375rem" wrap>
              <RouterLink
                v-for="r in grouped.sqs"
                :key="`q-${r.name}`"
                to="/queues"
                style="text-decoration: none;"
              >
                <TTag size="sm" variant="soft" clickable>{{ r.name }}</TTag>
              </RouterLink>
            </TStack>
          </TStack>

          <TStack v-if="grouped.sns?.length" direction="vertical" gap="0.5rem">
            <TStack direction="horizontal" gap="0.5rem" align="center">
              <TBadge tone="info" variant="soft">SNS topics</TBadge>
              <span class="muted">{{ grouped.sns.length }}</span>
            </TStack>
            <TStack direction="horizontal" gap="0.375rem" wrap>
              <TTag
                v-for="r in grouped.sns"
                :key="`t-${r.name}`"
                size="sm"
                variant="soft"
              >
                {{ r.name }}
              </TTag>
            </TStack>
          </TStack>

          <TStack v-if="grouped.s3?.length" direction="vertical" gap="0.5rem">
            <TStack direction="horizontal" gap="0.5rem" align="center">
              <TBadge tone="neutral" variant="soft">S3 buckets</TBadge>
              <span class="muted">{{ grouped.s3.length }}</span>
            </TStack>
            <TStack direction="horizontal" gap="0.375rem" wrap>
              <RouterLink
                v-for="r in grouped.s3"
                :key="`b-${r.name}`"
                :to="`/buckets/${encodeURIComponent(r.name)}`"
                style="text-decoration: none;"
              >
                <TTag size="sm" variant="soft" clickable>{{ r.name }}</TTag>
              </RouterLink>
            </TStack>
          </TStack>

          <TStack v-if="grouped.lambda?.length" direction="vertical" gap="0.5rem">
            <TStack direction="horizontal" gap="0.5rem" align="center">
              <TBadge tone="neutral" variant="soft">Lambda functions</TBadge>
              <span class="muted">{{ grouped.lambda.length }}</span>
            </TStack>
            <TStack direction="horizontal" gap="0.375rem" wrap>
              <TTag
                v-for="r in grouped.lambda"
                :key="`l-${r.name}`"
                size="sm"
                variant="soft"
              >
                λ {{ r.name }}
              </TTag>
            </TStack>
          </TStack>

          <TStack v-if="grouped.eventbus?.length" direction="vertical" gap="0.5rem">
            <TStack direction="horizontal" gap="0.5rem" align="center">
              <TBadge tone="info" variant="soft">EventBridge buses</TBadge>
              <span class="muted">{{ grouped.eventbus.length }}</span>
            </TStack>
            <TStack direction="horizontal" gap="0.375rem" wrap>
              <TTag
                v-for="r in grouped.eventbus"
                :key="`eb-${r.name}`"
                size="sm"
                variant="soft"
              >
                {{ r.name }}
              </TTag>
            </TStack>
          </TStack>

          <TStack v-if="grouped['event-rule']?.length" direction="vertical" gap="0.5rem">
            <TStack direction="horizontal" gap="0.5rem" align="center">
              <TBadge tone="info" variant="soft">EventBridge rules</TBadge>
              <span class="muted">{{ grouped['event-rule'].length }}</span>
            </TStack>
            <TStack direction="horizontal" gap="0.375rem" wrap>
              <TTag
                v-for="(r, idx) in grouped['event-rule']"
                :key="`er-${idx}-${r.name}`"
                size="sm"
                variant="outline"
              >
                {{ r.name }}
              </TTag>
            </TStack>
          </TStack>

          <TStack v-if="grouped.opensearch?.length" direction="vertical" gap="0.5rem">
            <TStack direction="horizontal" gap="0.5rem" align="center">
              <TBadge tone="info" variant="soft">OpenSearch collections</TBadge>
              <span class="muted">{{ grouped.opensearch.length }}</span>
            </TStack>
            <TStack direction="horizontal" gap="0.375rem" wrap>
              <TTag
                v-for="r in grouped.opensearch"
                :key="`os-${r.name}`"
                size="sm"
                variant="soft"
              >
                🔍 {{ r.name }}
              </TTag>
            </TStack>
          </TStack>

          <TStack v-if="grouped['event-source']?.length" direction="vertical" gap="0.5rem">
            <TStack direction="horizontal" gap="0.5rem" align="center">
              <TBadge tone="neutral" variant="soft">Event-source mappings</TBadge>
              <span class="muted">{{ grouped['event-source'].length }}</span>
            </TStack>
            <TStack direction="horizontal" gap="0.375rem" wrap>
              <TTag
                v-for="(r, idx) in grouped['event-source']"
                :key="`es-${idx}-${r.name}`"
                size="sm"
                variant="outline"
              >
                {{ r.name }}
              </TTag>
            </TStack>
          </TStack>
        </TStack>
      </TCard>
    </template>

    <TModal
      v-model:open="logsOpen"
      :title="`Logs — ${serviceName}`"
      :description="`Status: ${logsStatus}`"
      size="lg"
      @update:open="(v: boolean) => { if (!v) closeLogs(); }"
    >
      <pre class="logs-pre">{{ logs.join('\n') || '— no output yet —' }}</pre>
    </TModal>

    <TConfirmDialog
      v-model:open="deleteDialogOpen"
      :title="`Delete service “${serviceName}”?`"
      description="This removes the service from the cache and cleans up its provisioned resources in LocalStack."
      confirm-label="Delete"
      cancel-label="Cancel"
      confirm-variant="danger"
      @confirm="confirmDelete"
    />
  </TStack>
</template>
