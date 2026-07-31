<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import {
  TCard, TButton, TBadge, TStack, TGrid, TStat, TSpinner, TAlert,
  TTag, TEmptyState, TModal, TConfirmDialog, TText, TIcon, TCodeBlock, useToast,
  TDescriptionList, TDescriptionItem,
} from '@treeui/vue';
import type { TBadgeTone } from '@treeui/vue';
import { api } from '../services/api';
import type { ServiceDetail, ServiceResource } from '../services/api';
import { ENGINE_LABEL } from '../services/engine';
import { useI18n } from '../i18n';

const props = defineProps<{ serviceName: string }>();
const router = useRouter();
const toast = useToast();
const { t } = useI18n();

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
    error.value = err.message || t('services.notFound');
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
    toast.add({ title: t('services.startedToast'), description: props.serviceName, variant: 'success' });
    await load();
  } catch (err: any) {
    toast.add({ title: t('services.startFailedToast'), description: err.message, variant: 'danger' });
  } finally {
    starting.value = false;
  }
}

async function stopSvc() {
  if (stopping.value) return;
  stopping.value = true;
  try {
    await api.stopService(props.serviceName);
    toast.add({ title: t('services.stoppedToast'), description: props.serviceName, variant: 'info' });
    await load();
  } catch (err: any) {
    toast.add({ title: t('services.stopFailedToast'), description: err.message, variant: 'danger' });
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
    toast.add({ title: t('services.deletedToast'), description: props.serviceName, variant: 'info' });
    router.push('/services');
  } catch (err: any) {
    toast.add({ title: t('services.deleteFailedToast'), description: err.message, variant: 'danger' });
  } finally {
    deleteDialogOpen.value = false;
  }
}

function statusTone(status?: string): TBadgeTone {
  switch (status) {
    case 'running': return 'success';
    case 'registered': return 'warning';
    case 'stopped': return 'neutral';
    default: return 'danger';
  }
}

/**
 * Lifecycle state comes back as an English enum from the orchestrator; the
 * badge and the logs modal show it translated. Anything unrecognised falls
 * through to the raw value instead of an empty label.
 */
function statusLabel(status: string): string {
  switch (status) {
    case 'running': return t('services.statusRunning');
    case 'registered': return t('services.statusRegistered');
    case 'stopped': return t('common.stopped');
    case 'failed': return t('services.statusFailed');
    case 'error': return t('services.statusError');
    default: return status;
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
          <TButton size="sm" variant="ghost"><TIcon name="arrow-left" /> {{ t('nav.services') }}</TButton>
        </RouterLink>
        <TText weight="semibold" size="lg">{{ serviceName }}</TText>
        <TBadge v-if="service?.status" :tone="statusTone(service.status)" variant="soft">
          {{ statusLabel(service.status) }}
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
          {{ t('services.start') }}
        </TButton>
        <TButton
          size="sm"
          variant="soft"
          :disabled="service?.status !== 'running'"
          :loading="stopping"
          @click="stopSvc"
        >
          {{ t('services.stop') }}
        </TButton>
        <TButton size="sm" variant="ghost" @click="openLogs">{{ t('services.logs') }}</TButton>
        <TButton size="sm" variant="ghost" :loading="loading" @click="load">{{ t('common.refresh') }}</TButton>
        <TButton size="sm" variant="danger" @click="deleteDialogOpen = true">{{ t('common.delete') }}</TButton>
      </TStack>
    </TStack>

    <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
      {{ error }}
    </TAlert>

    <TStack v-if="loading && !service" direction="horizontal" justify="center" align="center">
      <TSpinner :label="t('services.loadingOne')" />
    </TStack>

    <template v-else-if="service">
      <TGrid :columns="5" gap="1rem">
        <TStat :label="t('services.statLambdas')" :value="grouped.lambda?.length || 0" tone="info" />
        <TStat :label="t('services.statTables')" :value="grouped.dynamodb?.length || 0" tone="info" />
        <TStat :label="t('services.statQueues')" :value="grouped.sqs?.length || 0" tone="warning" />
        <TStat :label="t('services.statTopics')" :value="grouped.sns?.length || 0" tone="info" />
        <TStat :label="t('services.statBuckets')" :value="grouped.s3?.length || 0" tone="neutral" />
      </TGrid>

      <TCard variant="outline">
        <template #header>
          <TText weight="semibold">{{ t('services.metadata') }}</TText>
        </template>
        <TDescriptionList>
          <TDescriptionItem :label="t('services.path')">
            <TText family="mono">{{ service.root }}</TText>
          </TDescriptionItem>
          <TDescriptionItem :label="t('common.region')">
            <TText family="mono">{{ service.region || '—' }}</TText>
          </TDescriptionItem>
          <TDescriptionItem :label="t('services.invokePort')">
            <TText family="mono">{{ service.invokePort ?? '—' }}</TText>
          </TDescriptionItem>
          <TDescriptionItem label="PID">
            <TText family="mono">{{ service.pid ?? '—' }}</TText>
          </TDescriptionItem>
          <TDescriptionItem :label="t('services.lastUpdated')">
            <span>{{ formatDate(service.lastUpdated) }}</span>
          </TDescriptionItem>
        </TDescriptionList>
      </TCard>

      <TCard variant="outline">
        <template #header>
          <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
            <TText weight="semibold">{{ t('services.declaredResources') }}</TText>
            <TBadge tone="neutral" variant="soft">
              {{ t('services.resourcesTotal', { count: service.resources?.length || 0 }) }}
            </TBadge>
          </TStack>
        </template>

        <TEmptyState
          v-if="!service.resources?.length"
          :title="t('services.noResourcesTitle')"
          :description="t('services.noResourcesDescription')"
        />

        <TStack v-else direction="vertical" gap="1rem">
          <TStack v-if="grouped.dynamodb?.length" direction="vertical" gap="0.5rem">
            <TStack direction="horizontal" gap="0.5rem" align="center">
              <TBadge tone="info" variant="soft">{{ t('services.groupTables') }}</TBadge>
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
              <TBadge tone="warning" variant="soft">{{ t('services.groupQueues') }}</TBadge>
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
              <TBadge tone="info" variant="soft">{{ t('services.groupTopics') }}</TBadge>
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
              <TBadge tone="neutral" variant="soft">{{ t('services.groupBuckets') }}</TBadge>
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
              <TBadge tone="neutral" variant="soft">{{ t('services.groupLambdas') }}</TBadge>
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
              <TBadge tone="info" variant="soft">{{ t('services.groupBuses') }}</TBadge>
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
              <TBadge tone="info" variant="soft">{{ t('services.groupRules') }}</TBadge>
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
              <TBadge tone="info" variant="soft">{{ t('services.groupCollections') }}</TBadge>
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
              <TBadge tone="neutral" variant="soft">{{ t('services.groupEventSources') }}</TBadge>
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
      :title="t('services.logsTitleFor', { name: serviceName })"
      :description="t('services.logsStatus', { status: statusLabel(logsStatus) })"
      size="lg"
      @update:open="(v: boolean) => { if (!v) closeLogs(); }"
    >
      <TCodeBlock
        :code="logs.join('\n') || t('services.logsEmpty')"
        :label="t('services.logsLabel')"
        max-block-size="60vh"
        wrap
        copyable
      />
    </TModal>

    <TConfirmDialog
      v-model:open="deleteDialogOpen"
      :title="t('services.deleteTitleNamed', { name: serviceName })"
      :description="t('services.deleteDescription', { engine: ENGINE_LABEL })"
      :confirm-label="t('common.delete')"
      :cancel-label="t('common.cancel')"
      confirm-variant="danger"
      @confirm="confirmDelete"
    />
  </TStack>
</template>
