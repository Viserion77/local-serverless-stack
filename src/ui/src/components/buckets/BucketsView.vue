<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import {
  TCard, TButton, TBadge, TTable, TEmptyState, TStack, TGrid, TStat,
  TTag, TSpinner, TAlert, TText, TLink,
} from '@treeui/vue';
import { api } from '../../services/api';
import type { BucketSnapshot } from '../../services/api';
import { engineLabel } from '../../services/engine';

const router = useRouter();
const buckets = ref<BucketSnapshot[]>([]);
const ownersByBucket = ref<Record<string, string>>({});
const loading = ref(true);
const error = ref<string | null>(null);
let refreshTimer: number | null = null;

const columns = [
  { key: 'name', label: 'Bucket' },
  { key: 'service', label: 'Service' },
  { key: 'objectCount', label: 'Objects', align: 'right' as const },
  { key: 'totalSize', label: 'Size', align: 'right' as const },
  { key: 'versioning', label: 'Versioning' },
  { key: 'notifications', label: 'Notifications', align: 'right' as const },
  { key: 'actions', label: '', align: 'right' as const },
];

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
    error.value = err.message || 'Failed to load buckets';
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
      <TStat label="Buckets" :value="totals.buckets" tone="info" :loading="loading" />
      <TStat label="Objects" :value="totals.objects" tone="success" :loading="loading" />
      <TStat label="Total size" :value="formatBytes(totals.size)" tone="neutral" :loading="loading" />
    </TGrid>

    <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
      {{ error }}
    </TAlert>

    <TCard variant="outline">
      <template #header>
        <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
          <TText weight="semibold">S3 Buckets</TText>
          <TText tone="muted">Refreshes every 10s</TText>
        </TStack>
      </template>

      <TStack v-if="loading" direction="horizontal" justify="center" align="center">
        <TSpinner label="Loading buckets..." />
      </TStack>

      <TEmptyState
        v-else-if="!buckets.length"
        title="No buckets found"
        :description="`Register a microservice that defines S3 resources, or create buckets directly on the ${engineLabel}.`"
      />

      <TTable v-else :columns="columns" :rows="rows" aria-label="S3 buckets">
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
          <TText v-else tone="muted" size="xs">unmanaged</TText>
        </template>

        <template #cell-objectCount="{ row }">
          <TBadge tone="info" variant="soft">{{ row.objectCount ?? 0 }}</TBadge>
        </template>

        <template #cell-totalSize="{ row }">
          {{ formatBytes(row.totalSize as number | undefined) }}
        </template>

        <template #cell-versioning="{ row }">
          <TBadge :tone="row.versioning ? 'success' : 'neutral'" variant="soft">
            {{ row.versioning ? 'Enabled' : 'Disabled' }}
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
            Open
          </TButton>
        </template>
      </TTable>
    </TCard>
  </TStack>
</template>
