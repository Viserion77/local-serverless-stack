<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import {
  TCard, TButton, TStack, TStackItem, TGrid, TStat, TEmptyState,
  TSpinner, TAlert, TTag, TTable, TText, TInput, TLink, TIcon,
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

// The row IS the link (TTable `rowTo`, 0.29): a real <a> in the first cell, so
// ctrl/middle-click, "open in new tab" and the status-bar URL work — none of
// which the previous `cursor:pointer` text did. Every collection in this list
// exists, so every row has a destination.
//
// The hit-area mismatch this comment used to record is closed as of 0.30: only
// the cells AFTER the first are positioned, so the overlay is contained by the
// <tr> and the clickable area is the whole row, which is what `cursor:pointer`
// on the <tr> was already promising.
function rowTo(row: Record<string, unknown>): string {
  return `/opensearch/${encodeURIComponent(String(row.name))}`;
}

// Required alongside `rowTo`: without it the link's accessible name is the
// whole row text (name, service, endpoint), repeated once per row. It runs per
// render, so t() follows a language switch.
function rowLabel(row: Record<string, unknown>): string {
  return t('opensearch.openCollectionLabel', { name: String(row.name) });
}

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
          <!-- One brand per list-card header: the screen is Amazon OpenSearch
               (the engine serves it as OpenSearch Serverless, 'aoss'). -->
          <TStack direction="horizontal" gap="0.5rem" align="center">
            <TIcon name="aws-opensearch" />
            <TText weight="semibold">{{ t('opensearch.listTitle') }}</TText>
          </TStack>
          <TStack direction="horizontal" align="center" gap="1rem">
            <!-- The floor is the flex item's, not the field's: TInput's `width`
                 is a cap (TFieldWidth), never a minimum. -->
            <TStackItem min-width="16rem">
              <TInput
                v-model="search"
                :placeholder="t('opensearch.filterPlaceholder')"
                :aria-label="t('opensearch.filterLabel')"
              />
            </TStackItem>
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
      >
        <template #icon>
          <TIcon name="aws-opensearch" />
        </template>
      </TEmptyState>

      <!-- Filter state, not a service state — stays a TreeUI functional icon. -->
      <TEmptyState
        v-else-if="!filteredRows.length"
        :title="t('opensearch.noMatchTitle')"
        :description="t('opensearch.noMatchDescription', { query: search })"
      >
        <template #icon>
          <TIcon name="search-x" />
        </template>
      </TEmptyState>

      <TTable
        v-else
        :columns="columns"
        :rows="filteredRows"
        row-key="name"
        :row-to="rowTo"
        :row-label="rowLabel"
        :aria-label="t('opensearch.listTitle')"
      >
        <template #cell-name="{ row }">
          <!-- Plain text: TTable wraps this cell in the row link itself, so the
               affordance is the row's (cursor, hover, focus ring) and the
               hand-rolled `cursor:pointer` + dotted underline goes with it.
               The clickable area is the whole row — see `rowTo`. -->
          <TText weight="semibold">{{ row.name }}</TText>
        </template>

        <template #cell-service="{ row }">
          <!-- TLink resolves RouterLink itself from `to`. `clickable` is not a
               TTag prop in any version — it was dropped silently, so the tag
               never gained an affordance; the link is what carries it. -->
          <TLink
            v-if="row.service"
            :to="`/services/${encodeURIComponent(String(row.service))}`"
            underline="none"
          >
            <TTag size="sm" variant="soft">{{ row.service }}</TTag>
          </TLink>
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
