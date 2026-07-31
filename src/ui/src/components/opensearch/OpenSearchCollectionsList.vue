<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { RouterLink } from 'vue-router';
import {
  TCard, TButton, TStack, TGrid, TStat, TEmptyState,
  TSpinner, TAlert, TTag, TTable, TText, TInput,
} from '@treeui/vue';
import { api } from '../../services/api';
import type { OpenSearchCollectionSummary, ResourceOwnersResponse } from '../../services/api';

const emit = defineEmits<{ (e: 'open', name: string): void }>();

const collections = ref<OpenSearchCollectionSummary[]>([]);
const ownersByCollection = ref<Record<string, string>>({});
const loading = ref(true);
const error = ref<string | null>(null);
const search = ref('');
let timer: number | null = null;

const columns = [
  { key: 'name', label: 'Collection' },
  { key: 'service', label: 'Service' },
  { key: 'endpoint', label: 'Data-plane endpoint' },
  { key: 'actions', label: '', align: 'right' as const },
];

const rows = computed(() =>
  collections.value
    .map(c => ({
      ...c,
      service: ownersByCollection.value[c.name] || '',
    }))
    .sort((a, b) => a.name.localeCompare(b.name)),
);

const filteredRows = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return rows.value;
  return rows.value.filter(r =>
    r.name.toLowerCase().includes(q) ||
    (r.service || '').toLowerCase().includes(q),
  );
});

const totals = computed(() => ({
  collections: collections.value.length,
  services: new Set(
    collections.value.map(c => ownersByCollection.value[c.name]).filter(Boolean),
  ).size,
}));

async function load() {
  try {
    const [list, owners] = await Promise.all([
      api.listOpenSearchCollections(),
      api.listResourceOwners().catch((): ResourceOwnersResponse => ({ tables: [], queues: [], topics: [], buckets: [], collections: [] })),
    ]);
    collections.value = list.collections;
    const map: Record<string, string> = {};
    for (const o of owners.collections || []) map[o.name] = o.service;
    ownersByCollection.value = map;
    error.value = null;
  } catch (err: any) {
    error.value = err.message || 'Failed to load OpenSearch collections';
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  load();
  timer = window.setInterval(load, 15000);
});

onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer);
});
</script>

<template>
  <TStack direction="vertical" gap="1.25rem">
    <TGrid :columns="2" gap="1rem">
      <TStat label="Collections" :value="totals.collections" tone="info" :loading="loading" />
      <TStat label="Owning services" :value="totals.services" tone="success" :loading="loading" />
    </TGrid>

    <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
      {{ error }}
    </TAlert>

    <TCard variant="outline">
      <template #header>
        <TStack direction="horizontal" justify="space-between" align="center" gap="1rem">
          <TText weight="semibold">OpenSearch collections</TText>
          <TStack direction="horizontal" align="center" gap="1rem">
            <TInput
              v-model="search"
              placeholder="Filter collections..."
              style="min-width: 16rem;"
            />
            <TText tone="muted" size="xs">Refreshes every 15s</TText>
          </TStack>
        </TStack>
      </template>

      <TStack v-if="loading" direction="horizontal" justify="center" align="center">
        <TSpinner label="Loading collections..." />
      </TStack>

      <TEmptyState
        v-else-if="!rows.length"
        title="No OpenSearch collections"
        description="Collections come from AWS::OpenSearchServerless::Collection resources — register a microservice that declares one."
      />

      <TEmptyState
        v-else-if="!filteredRows.length"
        title="No matching collections"
        :description="`No collections match &quot;${search}&quot;.`"
      />

      <TTable v-else :columns="columns" :rows="filteredRows" aria-label="OpenSearch collections">
        <template #cell-name="{ row }">
          <TText
            weight="semibold"
            style="cursor: pointer; text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 3px;"
            @click="emit('open', String(row.name))"
          >
            {{ row.name }}
          </TText>
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

        <template #cell-endpoint="{ row }">
          <TText tone="muted" family="mono" size="xs">{{ row.endpoint }}</TText>
        </template>

        <template #cell-actions="{ row }">
          <TButton size="sm" variant="soft" @click="emit('open', String(row.name))">
            Browse
          </TButton>
        </template>
      </TTable>
    </TCard>
  </TStack>
</template>
