<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import {
  TCard, TButton, TBadge, TTable, TEmptyState, TStack, TGrid, TStat,
  TTag, TSpinner, TAlert, TText, TLink,
} from '@treeui/vue';
import { api } from '../../services/api';
import type { BucketSnapshot } from '../../services/api';
import { ENGINE_LABEL } from '../../services/engine';
import { useI18n } from '../../i18n';

const { t } = useI18n();
const router = useRouter();
const buckets = ref<BucketSnapshot[]>([]);
const ownersByBucket = ref<Record<string, string>>({});
const loading = ref(true);
const error = ref<string | null>(null);
let refreshTimer: number | null = null;

// Computed rather than a module const: the headers have to go through t() at
// render time so switching language re-labels the table without a reload.
const columns = computed(() => [
  { key: 'name', label: t('buckets.colBucket') },
  { key: 'service', label: t('common.service') },
  { key: 'objectCount', label: t('buckets.colObjects'), align: 'right' as const },
  { key: 'totalSize', label: t('common.size'), align: 'right' as const },
  { key: 'versioning', label: t('buckets.colVersioning') },
  { key: 'notifications', label: t('buckets.colNotifications'), align: 'right' as const },
  { key: 'actions', label: '', align: 'right' as const },
]);

const rows = computed(() =>
  buckets.value.map(b => ({
    ...b,
    service: ownersByBucket.value[b.name] || '',
  })),
);

const totals = computed(() => ({
  buckets: buckets.value.length,
  objects: buckets.value.reduce((s, b) => s + (b.objectCount || 0), 0),
  size: buckets.value.reduce((s, b) => s + (b.totalSize || 0), 0),
}));

function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

async function load() {
  try {
    const [list, owners] = await Promise.all([
      api.listBuckets(),
      api.listResourceOwners().catch(() => ({ tables: [], queues: [], topics: [], buckets: [] })),
    ]);
    buckets.value = list;
    const map: Record<string, string> = {};
    for (const o of owners.buckets || []) map[o.name] = o.service;
    ownersByBucket.value = map;
    error.value = null;
  } catch (err: any) {
    error.value = err.message || t('buckets.loadFailed');
  } finally {
    loading.value = false;
  }
}

function openDetail(name: string) {
  router.push(`/buckets/${encodeURIComponent(name)}`);
}

onMounted(() => {
  load();
  refreshTimer = window.setInterval(load, 10000);
});

onBeforeUnmount(() => {
  if (refreshTimer) window.clearInterval(refreshTimer);
});
</script>

<template>
  <TStack direction="vertical" gap="1.25rem">
    <TGrid :columns="3" gap="1rem">
      <TStat :label="t('buckets.statBuckets')" :value="totals.buckets" tone="info" :loading="loading" />
      <TStat :label="t('buckets.statObjects')" :value="totals.objects" tone="success" :loading="loading" />
      <TStat
        :label="t('buckets.statTotalSize')"
        :value="formatBytes(totals.size)"
        tone="neutral"
        :loading="loading"
      />
    </TGrid>

    <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
      {{ error }}
    </TAlert>

    <TCard variant="outline">
      <template #header>
        <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
          <TText weight="semibold">{{ t('buckets.title') }}</TText>
          <TText tone="muted">{{ t('buckets.refreshHint') }}</TText>
        </TStack>
      </template>

      <TStack v-if="loading" direction="horizontal" justify="center" align="center">
        <TSpinner :label="t('buckets.loading')" />
      </TStack>

      <TEmptyState
        v-else-if="!buckets.length"
        :title="t('buckets.emptyTitle')"
        :description="t('buckets.emptyDescription', { engine: ENGINE_LABEL })"
      />

      <TTable v-else :columns="columns" :rows="rows" :aria-label="t('buckets.tableLabel')">
        <template #cell-name="{ row }">
          <TLink
            :to="`/buckets/${encodeURIComponent(String(row.name))}`"
            style="font-weight: 600;"
          >
            {{ row.name }}
          </TLink>
        </template>

        <template #cell-service="{ row }">
          <RouterLink
            v-if="row.service"
            :to="`/services/${encodeURIComponent(String(row.service))}`"
            style="text-decoration: none;"
          >
            <TTag size="sm" variant="soft" clickable>{{ row.service }}</TTag>
          </RouterLink>
          <TText v-else tone="muted" size="xs">{{ t('buckets.unmanaged') }}</TText>
        </template>

        <template #cell-objectCount="{ row }">
          <TBadge tone="info" variant="soft">{{ row.objectCount ?? 0 }}</TBadge>
        </template>

        <template #cell-totalSize="{ row }">
          {{ formatBytes(row.totalSize as number | undefined) }}
        </template>

        <template #cell-versioning="{ row }">
          <TBadge :tone="row.versioning ? 'success' : 'neutral'" variant="soft">
            {{ row.versioning ? t('buckets.enabled') : t('buckets.disabled') }}
          </TBadge>
        </template>

        <template #cell-notifications="{ row }">
          <TBadge
            :tone="Number(row.notifications) > 0 ? 'info' : 'neutral'"
            variant="soft"
          >
            {{ row.notifications ?? 0 }}
          </TBadge>
        </template>

        <template #cell-actions="{ row }">
          <TButton size="sm" variant="ghost" @click="openDetail(String(row.name))">
            {{ t('buckets.open') }}
          </TButton>
        </template>
      </TTable>
    </TCard>
  </TStack>
</template>
