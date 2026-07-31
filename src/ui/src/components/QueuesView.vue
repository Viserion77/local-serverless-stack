<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import {
  TCard, TButton, TBadge, TTable, TEmptyState, TStack, TGrid, TStat,
  TTag, TSpinner, TAlert, TText, TLink, TIcon,
} from '@treeui/vue';
import type { TBadgeTone } from '@treeui/vue';
import { api } from '../services/api';
import type { QueueSnapshot } from '../services/api';
import { ENGINE_LABEL } from '../services/engine';
import { useI18n } from '../i18n';

const { t } = useI18n();
const router = useRouter();
const queues = ref<QueueSnapshot[]>([]);
const ownersByQueue = ref<Record<string, string>>({});
const loading = ref(true);
const error = ref<string | null>(null);
let refreshTimer: number | null = null;

// Computed rather than a module const: the labels have to be re-read on a
// language switch, and `t()` is only reactive at call time.
const columns = computed(() => [
  { key: 'name', label: t('queues.colQueue') },
  { key: 'service', label: t('common.service') },
  { key: 'available', label: t('queues.colAvailable'), align: 'right' as const },
  { key: 'inFlight', label: t('queues.colInFlight'), align: 'right' as const },
  { key: 'processed', label: t('queues.colProcessed'), align: 'right' as const },
  { key: 'consumers', label: t('queues.colConsumers') },
  { key: 'actions', label: '', align: 'right' as const },
]);

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
    error.value = err.message || t('queues.loadListError');
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
  if (queue.available > 0) return t('queues.activityBacklog');
  if (queue.inFlight > 0) return t('queues.activityProcessing');
  if (!queue.consumers.length) return t('queues.noConsumers');
  return t('queues.activityIdle');
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
        :label="t('queues.statQueues')"
        :value="totals.queues"
        tone="info"
        :loading="loading"
      />
      <TStat
        :label="t('queues.statAvailable')"
        :value="totals.available"
        tone="warning"
        :loading="loading"
      />
      <TStat
        :label="t('queues.statInFlight')"
        :value="totals.inFlight"
        tone="info"
        :loading="loading"
      />
      <TStat
        :label="t('queues.statProcessed')"
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
          <!-- Queues are Amazon SQS throughout the app (engine service id
               'sqs'); the identity goes on the card header once. -->
          <TStack direction="horizontal" gap="0.5rem" align="center">
            <TIcon name="aws-sqs" />
            <TText weight="semibold">{{ t('queues.cardTitle') }}</TText>
          </TStack>
          <TText tone="muted">{{ t('queues.liveRefresh') }}</TText>
        </TStack>
      </template>

      <TStack v-if="loading" direction="horizontal" justify="center" align="center">
        <TSpinner :label="t('queues.loadingList')" />
      </TStack>

      <TEmptyState
        v-else-if="!queues.length"
        :title="t('queues.emptyTitle')"
        :description="t('queues.emptyDescription', { engine: ENGINE_LABEL })"
      >
        <template #icon>
          <TIcon name="aws-sqs" />
        </template>
      </TEmptyState>

      <TTable v-else :columns="columns" :rows="rows" :aria-label="t('queues.tableAria')">
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
          <TText v-else tone="muted" size="xs">{{ t('queues.unmanaged') }}</TText>
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

        <!-- Consumers are Lambda functions wired by event-source mappings — a
             cross-service reference, which is the strongest case for a mark
             inside a table cell. Decorative (the tag names the function), and
             sized down so the filled tile does not outweigh a `sm` tag. -->
        <template #cell-consumers="{ row }">
          <TStack direction="horizontal" gap="0.25rem" wrap>
            <template v-if="(row.consumers as any[]).length">
              <TTag
                v-for="c in (row.consumers as any[])"
                :key="c.uuid || c.functionName"
                size="sm"
                :variant="c.enabled ? 'solid' : 'outline'"
              >
                <template #icon><TIcon name="aws-lambda" size="14" /></template>
                {{ c.functionName }}
              </TTag>
            </template>
            <TBadge v-else tone="neutral" variant="soft">{{ t('queues.noConsumers') }}</TBadge>
          </TStack>
        </template>

        <template #cell-actions="{ row }">
          <TStack direction="horizontal" gap="0.375rem" justify="flex-end">
            <TBadge :tone="activityTone(row as any)" variant="solid">
              {{ activityLabel(row as any) }}
            </TBadge>
            <TButton size="sm" variant="ghost" @click="openDetail(String(row.name))">
              {{ t('queues.open') }}
            </TButton>
          </TStack>
        </template>
      </TTable>
    </TCard>
  </TStack>
</template>
