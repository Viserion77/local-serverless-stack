<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import {
  TCard, TButton, TBadge, TTable, TEmptyState, TStack, TGrid, TStat,
  TModal, TTag, TSpinner, TProgress, TDivider, TAlert, useToast,
} from '@treeui/vue';
import type { TreeBadgeTone } from '@treeui/vue';
import { api } from '../services/api';
import type { QueueSnapshot } from '../services/api';

const toast = useToast();
const queues = ref<QueueSnapshot[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const selectedQueueName = ref<string | null>(null);
let refreshTimer: number | null = null;

const columns = [
  { key: 'name', label: 'Queue' },
  { key: 'available', label: 'Available', align: 'right' as const },
  { key: 'inFlight', label: 'In flight', align: 'right' as const },
  { key: 'processed', label: 'Processed', align: 'right' as const },
  { key: 'consumers', label: 'Consumers' },
  { key: 'actions', label: '', align: 'right' as const },
];

const rows = computed(() =>
  queues.value.map(q => ({
    ...q,
    consumersCount: q.consumers.length,
  })),
);

const totals = computed(() => ({
  queues: queues.value.length,
  available: queues.value.reduce((s, q) => s + q.available, 0),
  inFlight: queues.value.reduce((s, q) => s + q.inFlight, 0),
  processed: queues.value.reduce((s, q) => s + q.processed, 0),
}));

const selectedQueue = computed(() =>
  selectedQueueName.value
    ? queues.value.find(q => q.name === selectedQueueName.value) || null
    : null,
);

const detailModalOpen = computed({
  get: () => selectedQueueName.value !== null,
  set: (value: boolean) => {
    if (!value) selectedQueueName.value = null;
  },
});

const selectedDepthRatio = computed(() => {
  const q = selectedQueue.value;
  if (!q) return 0;
  const all = q.available + q.inFlight + q.processed;
  if (!all) return 0;
  return Math.round((q.processed / all) * 100);
});

async function loadQueues() {
  try {
    queues.value = await api.listQueues();
    error.value = null;
  } catch (err: any) {
    error.value = err.message || 'Failed to load queues';
  } finally {
    loading.value = false;
  }
}

function openDetail(name: string) {
  selectedQueueName.value = name;
}

async function resetProcessed(name: string) {
  try {
    await api.resetQueueProcessed(name);
    toast.add({
      title: 'Processed counter reset',
      description: name,
      variant: 'info',
    });
    await loadQueues();
  } catch (err: any) {
    toast.add({
      title: 'Failed to reset counter',
      description: err.message,
      variant: 'danger',
    });
  }
}

function activityTone(queue: QueueSnapshot): TreeBadgeTone {
  if (queue.available > 0) return 'warning';
  if (queue.inFlight > 0) return 'info';
  if (queue.consumers.some(c => c.enabled)) return 'success';
  return 'neutral';
}

function activityLabel(queue: QueueSnapshot): string {
  if (queue.available > 0) return 'Backlog';
  if (queue.inFlight > 0) return 'Processing';
  if (!queue.consumers.length) return 'No consumers';
  return 'Idle';
}

function formatSeconds(value?: number): string {
  if (value === undefined) return '—';
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.round(value / 60)}m`;
  if (value < 86400) return `${Math.round(value / 3600)}h`;
  return `${Math.round(value / 86400)}d`;
}

function formatDate(ts?: number): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

onMounted(() => {
  loadQueues();
  refreshTimer = window.setInterval(loadQueues, 4000);
});

onBeforeUnmount(() => {
  if (refreshTimer) window.clearInterval(refreshTimer);
});
</script>

<template>
  <TStack direction="vertical" gap="1.25rem">
    <TGrid :columns="4" gap="1rem">
      <TStat
        label="Queues"
        :value="totals.queues"
        tone="info"
        :loading="loading"
      />
      <TStat
        label="Available messages"
        :value="totals.available"
        tone="warning"
        :loading="loading"
      />
      <TStat
        label="In flight"
        :value="totals.inFlight"
        tone="info"
        :loading="loading"
      />
      <TStat
        label="Processed"
        :value="totals.processed"
        tone="success"
        :loading="loading"
      />
    </TGrid>

    <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
      {{ error }}
    </TAlert>

    <TCard variant="outline">
      <template #header>
        <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
          <strong>SQS Queues</strong>
          <span class="muted">Live · refreshes every 4s</span>
        </TStack>
      </template>

      <div v-if="loading" style="display: flex; justify-content: center; padding: 2rem;">
        <TSpinner label="Loading queues..." />
      </div>

      <TEmptyState
        v-else-if="!queues.length"
        title="No queues found"
        description="Register a microservice that defines SQS resources or create queues directly in LocalStack."
      />

      <TTable v-else :columns="columns" :rows="rows">
        <template #cell-name="{ row }">
          <TStack direction="vertical" gap="0.125rem">
            <strong>{{ row.name }}</strong>
            <span class="muted mono" style="font-size: 0.75rem;">
              {{ String(row.arn || row.url || '') }}
            </span>
          </TStack>
        </template>

        <template #cell-available="{ row }">
          <TBadge
            :tone="Number(row.available) > 0 ? 'warning' : 'neutral'"
            variant="soft"
          >
            {{ row.available }}
          </TBadge>
        </template>

        <template #cell-inFlight="{ row }">
          <TBadge
            :tone="Number(row.inFlight) > 0 ? 'info' : 'neutral'"
            variant="soft"
          >
            {{ row.inFlight }}
          </TBadge>
        </template>

        <template #cell-processed="{ row }">
          <TBadge tone="success" variant="soft">{{ row.processed }}</TBadge>
        </template>

        <template #cell-consumers="{ row }">
          <TStack direction="horizontal" gap="0.25rem" wrap>
            <template v-if="(row.consumers as any[]).length">
              <TTag
                v-for="c in (row.consumers as any[])"
                :key="c.uuid || c.functionName"
                size="sm"
                :variant="c.enabled ? 'solid' : 'outline'"
              >
                {{ c.functionName }}
              </TTag>
            </template>
            <TBadge v-else tone="neutral" variant="soft">No consumers</TBadge>
          </TStack>
        </template>

        <template #cell-actions="{ row }">
          <TStack direction="horizontal" gap="0.375rem" justify="flex-end">
            <TBadge :tone="activityTone(row as any)" variant="solid">
              {{ activityLabel(row as any) }}
            </TBadge>
            <TButton size="sm" variant="ghost" @click="openDetail(String(row.name))">
              Details
            </TButton>
          </TStack>
        </template>
      </TTable>
    </TCard>

    <TModal
      v-model:open="detailModalOpen"
      size="lg"
      :title="selectedQueue ? selectedQueue.name : 'Queue details'"
      :description="selectedQueue?.arn || ''"
    >
      <TStack v-if="selectedQueue" direction="vertical" gap="1rem">
        <TGrid :columns="3" gap="0.75rem">
          <TStat
            label="Available"
            :value="selectedQueue.available"
            tone="warning"
          />
          <TStat
            label="In flight"
            :value="selectedQueue.inFlight"
            tone="info"
          />
          <TStat
            label="Processed (this session)"
            :value="selectedQueue.processed"
            tone="success"
          />
        </TGrid>

        <TStack direction="vertical" gap="0.25rem">
          <TStack direction="horizontal" justify="space-between" align="center">
            <span class="muted">Throughput share (processed)</span>
            <span class="mono">{{ selectedDepthRatio }}%</span>
          </TStack>
          <TProgress :value="selectedDepthRatio" />
        </TStack>

        <TDivider />

        <TStack direction="vertical" gap="0.5rem">
          <strong>Consumers</strong>
          <TStack
            v-if="selectedQueue.consumers.length"
            direction="vertical"
            gap="0.5rem"
          >
            <TCard
              v-for="c in selectedQueue.consumers"
              :key="c.uuid || c.functionName"
              variant="soft"
            >
              <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
                <TStack direction="vertical" gap="0.125rem">
                  <span class="mono">{{ c.functionName }}</span>
                  <span class="muted" style="font-size: 0.75rem;">
                    UUID: {{ c.uuid || '—' }} · batch size {{ c.batchSize ?? '—' }}
                  </span>
                </TStack>
                <TBadge :tone="c.enabled ? 'success' : 'neutral'" variant="soft">
                  {{ c.state || (c.enabled ? 'Enabled' : 'Disabled') }}
                </TBadge>
              </TStack>
            </TCard>
          </TStack>
          <TEmptyState
            v-else
            title="No consumers attached"
            description="No Lambda event-source mapping currently points at this queue."
          />
        </TStack>

        <TDivider />

        <TStack direction="vertical" gap="0.25rem">
          <strong>Attributes</strong>
          <TStack direction="horizontal" gap="0.5rem" wrap>
            <TTag size="sm" variant="soft">
              FIFO: {{ selectedQueue.fifo ? 'yes' : 'no' }}
            </TTag>
            <TTag size="sm" variant="soft">
              Visibility timeout: {{ formatSeconds(selectedQueue.visibilityTimeout) }}
            </TTag>
            <TTag size="sm" variant="soft">
              Retention: {{ formatSeconds(selectedQueue.messageRetentionPeriod) }}
            </TTag>
            <TTag size="sm" variant="soft">
              Delayed: {{ selectedQueue.delayed }}
            </TTag>
          </TStack>
          <span class="muted" style="font-size: 0.75rem;">
            Created {{ formatDate(selectedQueue.createdAt) }} · last polled
            {{ formatDate(selectedQueue.lastPolledAt) }}
          </span>
        </TStack>
      </TStack>

      <template #footer>
        <TStack direction="horizontal" gap="0.5rem" justify="flex-end">
          <TButton
            v-if="selectedQueue"
            variant="ghost"
            size="sm"
            @click="resetProcessed(selectedQueue.name)"
          >
            Reset processed counter
          </TButton>
          <TButton variant="soft" size="sm" @click="detailModalOpen = false">
            Close
          </TButton>
        </TStack>
      </template>
    </TModal>
  </TStack>
</template>
