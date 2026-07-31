<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import {
  TCard, TButton, TBadge, TTable, TEmptyState, TStack, TGrid, TStat,
  TTag, TSpinner, TAlert, TText, TLink,
} from '@treeui/vue';
import type { TBadgeTone } from '@treeui/vue';
import { api } from '../services/api';
import type { QueueSnapshot } from '../services/api';
import { ENGINE_LABEL } from '../services/engine';

const router = useRouter();
const queues = ref<QueueSnapshot[]>([]);
const ownersByQueue = ref<Record<string, string>>({});
const loading = ref(true);
const error = ref<string | null>(null);
let refreshTimer: number | null = null;

const columns = [
  { key: 'name', label: 'Queue' },
  { key: 'service', label: 'Service' },
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
    service: ownersByQueue.value[q.name] || '',
  })),
);

const totals = computed(() => ({
  queues: queues.value.length,
  available: queues.value.reduce((s, q) => s + q.available, 0),
  inFlight: queues.value.reduce((s, q) => s + q.inFlight, 0),
  processed: queues.value.reduce((s, q) => s + q.processed, 0),
}));

async function loadQueues() {
  try {
    const [list, owners] = await Promise.all([
      api.listQueues(),
      api.listResourceOwners().catch(() => ({ tables: [], queues: [], topics: [], buckets: [] })),
    ]);
    queues.value = list;
    const map: Record<string, string> = {};
    for (const o of owners.queues) map[o.name] = o.service;
    ownersByQueue.value = map;
    error.value = null;
  } catch (err: any) {
    error.value = err.message || 'Failed to load queues';
  } finally {
    loading.value = false;
  }
}

function openDetail(name: string) {
  router.push(`/queues/${encodeURIComponent(name)}`);
}

function activityTone(queue: QueueSnapshot): TBadgeTone {
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
          <TText weight="semibold">SQS Queues</TText>
          <TText tone="muted">Live · refreshes every 4s</TText>
        </TStack>
      </template>

      <TStack v-if="loading" direction="horizontal" justify="center" align="center">
        <TSpinner label="Loading queues..." />
      </TStack>

      <TEmptyState
        v-else-if="!queues.length"
        title="No queues found"
        :description="`Register a microservice that defines SQS resources, or create queues directly on the ${ENGINE_LABEL}.`"
      />

      <TTable v-else :columns="columns" :rows="rows" aria-label="SQS queues">
        <template #cell-name="{ row }">
          <TStack direction="vertical" gap="0.125rem">
            <TLink
              :to="`/queues/${encodeURIComponent(String(row.name))}`"
              style="font-weight: 600;"
            >
              {{ row.name }}
            </TLink>
            <TText tone="muted" family="mono" size="xs">
              {{ String(row.arn || row.url || '') }}
            </TText>
          </TStack>
        </template>

        <template #cell-service="{ row }">
          <RouterLink
            v-if="row.service"
            :to="`/services/${encodeURIComponent(String(row.service))}`"
            style="text-decoration: none;"
          >
            <TTag size="sm" variant="soft" clickable>{{ row.service }}</TTag>
          </RouterLink>
          <TText v-else tone="muted" size="xs">unmanaged</TText>
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
              Open
            </TButton>
          </TStack>
        </template>
      </TTable>
    </TCard>
  </TStack>
</template>
