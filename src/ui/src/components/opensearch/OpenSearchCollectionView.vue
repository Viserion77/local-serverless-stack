<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import {
  TCard, TButton, TBadge, TStack, TTable, TEmptyState, TSpinner, TAlert,
  TInput, TSelect, TFormField, TText, TIcon, TCodeBlock,
} from '@treeui/vue';
import { api } from '../../services/api';
import type {
  OpenSearchIndexSummary, OpenSearchSearchInput, OpenSearchSearchResponse,
} from '../../services/api';

const props = defineProps<{ name: string }>();
const emit = defineEmits<{ (e: 'back'): void }>();

const indices = ref<OpenSearchIndexSummary[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

const searchIndex = ref('');
const searchText = ref('');
const searchSize = ref('25');
const searching = ref(false);
const searchError = ref<string | null>(null);
const result = ref<OpenSearchSearchResponse | null>(null);
const notFoundHint = ref(false);

const indexColumns = [
  { key: 'index', label: 'Index' },
  { key: 'docsCount', label: 'Docs', align: 'right' as const },
  { key: 'health', label: 'Health' },
  { key: 'status', label: 'Status' },
];

const hitColumns = [
  { key: 'index', label: 'Index' },
  { key: 'id', label: 'ID' },
  { key: 'source', label: 'Source' },
];

const indexOptions = computed(() => [
  { value: '', label: 'All indices' },
  ...indices.value.map(i => ({ value: i.index, label: i.index })),
]);

const sizeOptions = [
  { value: '10', label: '10 results' },
  { value: '25', label: '25 results' },
  { value: '50', label: '50 results' },
];

const hitRows = computed(() =>
  (result.value?.hits.hits || []).map(h => ({
    index: h._index,
    id: h._id,
    source: JSON.stringify(h._source, null, 2),
  })),
);

function healthTone(health: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (health === 'green') return 'success';
  if (health === 'yellow') return 'warning';
  if (health === 'red') return 'danger';
  return 'neutral';
}

async function load() {
  loading.value = true;
  try {
    const res = await api.listOpenSearchIndices(props.name);
    indices.value = res.indices;
    error.value = null;
  } catch (err: any) {
    error.value = err.message || 'Failed to load indices';
    indices.value = [];
  } finally {
    loading.value = false;
  }
}

async function runSearch() {
  searching.value = true;
  searchError.value = null;
  notFoundHint.value = false;
  try {
    const input: OpenSearchSearchInput = { size: Number(searchSize.value) };
    if (searchIndex.value) input.index = searchIndex.value;
    const q = searchText.value.trim();
    if (q) input.q = q;
    result.value = await api.searchOpenSearch(props.name, input);
  } catch (err: any) {
    // Indices only exist after the first document is written — treat a 404
    // as an empty result with a hint, mirroring the example search handlers.
    // The emulator words these as "no such index [x]" / "Collection x does
    // not exist"; the generic explorer fallback says "HTTP 404".
    if (/not[_ ]?found|no such index|does not exist|404/i.test(String(err?.message || ''))) {
      result.value = { took: 0, hits: { total: { value: 0 }, hits: [] } };
      notFoundHint.value = true;
    } else {
      result.value = null;
      searchError.value = err.message || 'Search failed';
    }
  } finally {
    searching.value = false;
  }
}

onMounted(load);
watch(() => props.name, load);
</script>

<template>
  <TStack direction="vertical" gap="1rem">
    <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
      <TStack direction="horizontal" gap="0.5rem" align="center">
        <TButton size="sm" variant="ghost" @click="emit('back')"><TIcon name="arrow-left" /> Collections</TButton>
        <TText size="lg" weight="semibold">{{ name }}</TText>
        <TBadge tone="info" variant="soft">
          {{ indices.length }} {{ indices.length === 1 ? 'index' : 'indices' }}
        </TBadge>
      </TStack>
      <TButton size="sm" variant="ghost" :loading="loading" @click="load">Refresh</TButton>
    </TStack>

    <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
      {{ error }}
    </TAlert>

    <TCard variant="outline">
      <template #header>
        <TText weight="semibold">Indices</TText>
      </template>

      <TStack v-if="loading && !indices.length" direction="horizontal" justify="center" align="center">
        <TSpinner label="Loading indices..." />
      </TStack>

      <TEmptyState
        v-else-if="!indices.length"
        title="No indices yet"
        description="Indices are created when the first document is indexed into this collection."
      />

      <TTable v-else :columns="indexColumns" :rows="indices" aria-label="OpenSearch indices">
        <template #cell-index="{ row }">
          <TText weight="semibold">{{ row.index }}</TText>
        </template>

        <template #cell-docsCount="{ row }">
          <TBadge tone="info" variant="soft">{{ row.docsCount ?? 0 }}</TBadge>
        </template>

        <template #cell-health="{ row }">
          <TBadge :tone="healthTone(String(row.health))" variant="soft">
            {{ row.health || '—' }}
          </TBadge>
        </template>

        <template #cell-status="{ row }">
          <TBadge :tone="row.status === 'open' ? 'success' : 'neutral'" variant="soft">
            {{ row.status || '—' }}
          </TBadge>
        </template>
      </TTable>
    </TCard>

    <TCard variant="outline">
      <template #header>
        <TText weight="semibold">Search documents</TText>
      </template>

      <TStack direction="horizontal" gap="1rem" align="end">
        <TFormField label="Index" style="flex: 1;">
          <TSelect v-model="searchIndex" :options="indexOptions" />
        </TFormField>
        <TFormField label="Query" style="flex: 2;">
          <TInput
            v-model="searchText"
            placeholder="Free-text query — leave empty to match all documents"
            @keyup.enter="runSearch"
          />
        </TFormField>
        <TFormField label="Size" style="flex: 0.8; min-width: 8rem;">
          <TSelect v-model="searchSize" :options="sizeOptions" />
        </TFormField>
        <TButton variant="solid" :loading="searching" @click="runSearch">Search</TButton>
      </TStack>
    </TCard>

    <TAlert v-if="searchError" variant="danger" dismissible @dismiss="searchError = null">
      {{ searchError }}
    </TAlert>

    <TCard v-if="result" variant="outline">
      <template #header>
        <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
          <TText weight="semibold">Results</TText>
          <TText tone="muted" size="xs">
            {{ result.hits.total.value }} hit{{ result.hits.total.value === 1 ? '' : 's' }}
            · took {{ result.took }} ms
          </TText>
        </TStack>
      </template>

      <TEmptyState
        v-if="!hitRows.length"
        title="No documents found"
        :description="notFoundHint
          ? 'The index does not exist yet — it is created when the first document is indexed.'
          : 'No documents match this search.'"
      />

      <TTable v-else :columns="hitColumns" :rows="hitRows" aria-label="Search result documents">
        <template #cell-index="{ row }">
          <TText family="mono" style="font-size: 0.78rem;">{{ row.index }}</TText>
        </template>

        <template #cell-id="{ row }">
          <TText family="mono" style="font-size: 0.78rem;">{{ row.id }}</TText>
        </template>

        <template #cell-source="{ row }">
          <TCodeBlock :code="row.source" label="Search document" max-block-size="24rem" wrap copyable />
        </template>
      </TTable>
    </TCard>
  </TStack>
</template>
