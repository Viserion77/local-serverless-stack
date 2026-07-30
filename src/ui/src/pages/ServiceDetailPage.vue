<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import {
  TCard, TButton, TBadge, TStack, TGrid, TStat, TSpinner, TAlert,
  TTag, TEmptyState, TModal, TConfirmDialog, TText, TIcon, TCodeBlock, useToast,
  TDescriptionList, TDescriptionItem,
} from '@treeui/vue';
import type { TreeBadgeTone } from '@treeui/vue';
import { api } from '../services/api';
import type { ServiceDetail, ServiceResource } from '../services/api';
import { engineLabel } from '../services/engine';

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
          <TButton size="sm" variant="ghost"><TIcon name="arrow-left" /> Services</TButton>
        </RouterLink>
        <TText weight="semibold" size="lg">{{ serviceName }}</TText>
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

    <TStack v-if="loading && !service" direction="horizontal" justify="center" align="center">
      <TSpinner label="Loading service..." />
    </TStack>

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
          <TText weight="semibold">Metadata</TText>
        </template>
        <TDescriptionList>
          <TDescriptionItem label="Path">
            <TText family="mono">{{ service.root }}</TText>
          </TDescriptionItem>
          <TDescriptionItem label="Region">
            <TText family="mono">{{ service.region || '—' }}</TText>
          </TDescriptionItem>
          <TDescriptionItem label="Invoke port">
            <TText family="mono">{{ service.invokePort ?? '—' }}</TText>
          </TDescriptionItem>
          <TDescriptionItem label="PID">
            <TText family="mono">{{ service.pid ?? '—' }}</TText>
          </TDescriptionItem>
          <TDescriptionItem label="Last updated">
            <span>{{ formatDate(service.lastUpdated) }}</span>
          </TDescriptionItem>
        </TDescriptionList>
      </TCard>

      <TCard variant="outline">
        <template #header>
          <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
            <TText weight="semibold">Declared resources</TText>
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
              <TText tone="muted">{{ grouped.dynamodb.length }}</TText>
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
              <TText tone="muted">{{ grouped.sqs.length }}</TText>
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
              <TText tone="muted">{{ grouped.sns.length }}</TText>
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
              <TText tone="muted">{{ grouped.s3.length }}</TText>
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
              <TText tone="muted">{{ grouped.lambda.length }}</TText>
            </TStack>
            <TStack direction="horizontal" gap="0.375rem" wrap>
              <TTag
                v-for="r in grouped.lambda"
                :key="`l-${r.name}`"
                size="sm"
                variant="soft"
              >
                <TIcon name="code" /> {{ r.name }}
              </TTag>
            </TStack>
          </TStack>

          <TStack v-if="grouped.eventbus?.length" direction="vertical" gap="0.5rem">
            <TStack direction="horizontal" gap="0.5rem" align="center">
              <TBadge tone="info" variant="soft">EventBridge buses</TBadge>
              <TText tone="muted">{{ grouped.eventbus.length }}</TText>
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
              <TText tone="muted">{{ grouped['event-rule'].length }}</TText>
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
              <TText tone="muted">{{ grouped.opensearch.length }}</TText>
            </TStack>
            <TStack direction="horizontal" gap="0.375rem" wrap>
              <TTag
                v-for="r in grouped.opensearch"
                :key="`os-${r.name}`"
                size="sm"
                variant="soft"
              >
                <TIcon name="search" /> {{ r.name }}
              </TTag>
            </TStack>
          </TStack>

          <TStack v-if="grouped['event-source']?.length" direction="vertical" gap="0.5rem">
            <TStack direction="horizontal" gap="0.5rem" align="center">
              <TBadge tone="neutral" variant="soft">Event-source mappings</TBadge>
              <TText tone="muted">{{ grouped['event-source'].length }}</TText>
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
      <TCodeBlock :code="logs.join('\n') || '— no output yet —'" label="Service log" max-block-size="60vh" wrap copyable />
    </TModal>

    <TConfirmDialog
      v-model:open="deleteDialogOpen"
      :title="`Delete service “${serviceName}”?`"
      :description="`This removes the service from the cache and cleans up its provisioned resources on the ${engineLabel}.`"
      confirm-label="Delete"
      cancel-label="Cancel"
      confirm-variant="danger"
      @confirm="confirmDelete"
    />
  </TStack>
</template>
