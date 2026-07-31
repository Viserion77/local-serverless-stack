<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { RouterLink } from 'vue-router';
import {
  TCard, TButton, TStack, TGrid, TStat, TEmptyState,
  TSpinner, TAlert, TTag, TTable, TText, TInput,
} from '@treeui/vue';
import { api } from '../../services/api';
import type { OpenSearchCollectionSummary, ResourceOwnersResponse } from '../../services/api';
import { useI18n } from '../../i18n';

const emit = defineEmits<{ (e: 'open', name: string): void }>();

const { t } = useI18n();

const collections = ref<OpenSearchCollectionSummary[]>([]);
const ownersByCollection = ref<Record<string, string>>({});
const loading = ref(true);
const error = ref<string | null>(null);
const search = ref('');
let timer: number | null = null;

// Computed rather than a module const: the header labels have to re-render
// when the user switches language.
const columns = computed(() => [
  { key: 'name', label: t('opensearch.collection') },
  { key: 'service', label: t('common.service') },
  { key: 'endpoint', label: t('opensearch.endpoint') },
  { key: 'actions', label: '', align: 'right' as const },
]);

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
    error.value = err.message || t('opensearch.loadCollectionsError');
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
      <TStat :label="t('opensearch.collections')" :value="totals.collections" tone="info" :loading="loading" />
      <TStat :label="t('opensearch.owningServices')" :value="totals.services" tone="success" :loading="loading" />
    </TGrid>

    <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
      {{ error }}
    </TAlert>

    <TCard variant="outline">
      <template #header>
        <TStack direction="horizontal" justify="space-between" align="center" gap="1rem">
          <TText weight="semibold">{{ t('opensearch.listTitle') }}</TText>
          <TStack direction="horizontal" align="center" gap="1rem">
            <TInput
              v-model="search"
              :placeholder="t('opensearch.filterPlaceholder')"
              style="min-width: 16rem;"
            />
            <TText tone="muted" size="xs">{{ t('opensearch.refreshHint') }}</TText>
          </TStack>
        </TStack>
      </template>

      <TStack v-if="loading" direction="horizontal" justify="center" align="center">
        <TSpinner :label="t('opensearch.loadingCollections')" />
      </TStack>

      <TEmptyState
        v-else-if="!rows.length"
        :title="t('opensearch.emptyTitle')"
        :description="t('opensearch.emptyDescription')"
      />

      <TEmptyState
        v-else-if="!filteredRows.length"
        :title="t('opensearch.noMatchTitle')"
        :description="t('opensearch.noMatchDescription', { query: search })"
      />

      <TTable v-else :columns="columns" :rows="filteredRows" :aria-label="t('opensearch.listTitle')">
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
          <TText v-else tone="muted" size="xs">{{ t('opensearch.unmanaged') }}</TText>
        </template>

        <template #cell-endpoint="{ row }">
          <TText tone="muted" family="mono" size="xs">{{ row.endpoint }}</TText>
        </template>

        <template #cell-actions="{ row }">
          <TButton size="sm" variant="soft" @click="emit('open', String(row.name))">
            {{ t('opensearch.browse') }}
          </TButton>
        </template>
      </TTable>
    </TCard>
  </TStack>
</template>
