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
import { useI18n } from '../../i18n';

const props = defineProps<{ name: string }>();
const emit = defineEmits<{ (e: 'back'): void }>();

const { t } = useI18n();

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

// Computed rather than module consts: the labels have to re-render when the
// user switches language. `ID` and `Source` stay untranslated — they name the
// `_id` / `_source` fields of an OpenSearch hit.
const indexColumns = computed(() => [
  { key: 'index', label: t('opensearch.index') },
  { key: 'docsCount', label: t('opensearch.docs'), align: 'right' as const },
  { key: 'health', label: t('opensearch.health') },
  { key: 'status', label: t('common.status') },
]);

const hitColumns = computed(() => [
  { key: 'index', label: t('opensearch.index') },
  { key: 'id', label: 'ID' },
  { key: 'source', label: 'Source' },
]);

const indexOptions = computed(() => [
  { value: '', label: t('opensearch.allIndices') },
  ...indices.value.map(i => ({ value: i.index, label: i.index })),
]);

const sizeOptions = computed(() => [
  { value: '10', label: t('opensearch.resultsSize', { count: 10 }) },
  { value: '25', label: t('opensearch.resultsSize', { count: 25 }) },
  { value: '50', label: t('opensearch.resultsSize', { count: 50 }) },
]);

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
    error.value = err.message || t('opensearch.loadIndicesError');
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
      searchError.value = err.message || t('opensearch.searchError');
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
        <TButton size="sm" variant="ghost" @click="emit('back')">
          <TIcon name="arrow-left" /> {{ t('opensearch.backToCollections') }}
        </TButton>
        <TText size="lg" weight="semibold">{{ name }}</TText>
        <TBadge tone="info" variant="soft">
          {{ t(indices.length === 1 ? 'opensearch.indexCountOne' : 'opensearch.indexCountOther', { count: indices.length }) }}
        </TBadge>
      </TStack>
      <TButton size="sm" variant="ghost" :loading="loading" @click="load">{{ t('common.refresh') }}</TButton>
    </TStack>

    <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
      {{ error }}
    </TAlert>

    <TCard variant="outline">
      <template #header>
        <TText weight="semibold">{{ t('opensearch.indicesTitle') }}</TText>
      </template>

      <TStack v-if="loading && !indices.length" direction="horizontal" justify="center" align="center">
        <TSpinner :label="t('opensearch.loadingIndices')" />
      </TStack>

      <TEmptyState
        v-else-if="!indices.length"
        :title="t('opensearch.noIndicesTitle')"
        :description="t('opensearch.noIndicesDescription')"
      />

      <TTable v-else :columns="indexColumns" :rows="indices" :aria-label="t('opensearch.indicesAriaLabel')">
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
        <TText weight="semibold">{{ t('opensearch.searchTitle') }}</TText>
      </template>

      <TStack direction="horizontal" gap="1rem" align="end">
        <TFormField :label="t('opensearch.index')" style="flex: 1;">
          <TSelect v-model="searchIndex" :options="indexOptions" />
        </TFormField>
        <TFormField :label="t('opensearch.query')" style="flex: 2;">
          <TInput
            v-model="searchText"
            :placeholder="t('opensearch.queryPlaceholder')"
            @keyup.enter="runSearch"
          />
        </TFormField>
        <TFormField :label="t('common.size')" style="flex: 0.8; min-width: 8rem;">
          <TSelect v-model="searchSize" :options="sizeOptions" />
        </TFormField>
        <TButton variant="solid" :loading="searching" @click="runSearch">{{ t('common.search') }}</TButton>
      </TStack>
    </TCard>

    <TAlert v-if="searchError" variant="danger" dismissible @dismiss="searchError = null">
      {{ searchError }}
    </TAlert>

    <TCard v-if="result" variant="outline">
      <template #header>
        <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
          <TText weight="semibold">{{ t('opensearch.resultsTitle') }}</TText>
          <TText tone="muted" size="xs">
            {{ t(
              result.hits.total.value === 1 ? 'opensearch.hitsSummaryOne' : 'opensearch.hitsSummaryOther',
              { count: result.hits.total.value, took: result.took },
            ) }}
          </TText>
        </TStack>
      </template>

      <TEmptyState
        v-if="!hitRows.length"
        :title="t('opensearch.noHitsTitle')"
        :description="notFoundHint
          ? t('opensearch.noHitsIndexMissing')
          : t('opensearch.noHitsDescription')"
      />

      <TTable v-else :columns="hitColumns" :rows="hitRows" :aria-label="t('opensearch.hitsAriaLabel')">
        <template #cell-index="{ row }">
          <TText family="mono" style="font-size: 0.78rem;">{{ row.index }}</TText>
        </template>

        <template #cell-id="{ row }">
          <TText family="mono" style="font-size: 0.78rem;">{{ row.id }}</TText>
        </template>

        <template #cell-source="{ row }">
          <TCodeBlock
            :code="String(row.source ?? '')"
            :label="t('opensearch.documentLabel')"
            max-block-size="24rem"
            wrap
            copyable
          />
        </template>
      </TTable>
    </TCard>
  </TStack>
</template>
