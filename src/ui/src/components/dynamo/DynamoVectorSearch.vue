<script setup lang="ts">
// Similarity search over a DynamoDB vector index (SearchVectors). The point is
// debugging embeddings: pick an item and see whether its nearest neighbours
// are the ones you expect, or paste a query vector straight from your model.
// The engine does the ranking (exact k-NN, AWS scores); this panel only
// builds the request and renders the result. TreeUI only — no local CSS.
import { ref, computed, watch } from 'vue';
import {
  TCard, TButton, TStack, TStackItem, TTable, TEmptyState, TSpinner, TAlert,
  TInput, TSelect, TFormField, TToggleGroup, TText, TTextarea, TNumberInput,
  TCombobox, TProgress, TTag, TDivider,
} from '@treeui/vue';
import type { TToggleGroupOption, TComboboxOption } from '@treeui/vue';
import { api } from '../../services/api';
import type { DynamoTableDetail, DynamoVectorIndex, DynamoVectorSearchOutput } from '../../services/api';
import { useI18n } from '../../i18n';

const props = defineProps<{ table: DynamoTableDetail; initialIndex?: string }>();

const { t } = useI18n();

type Source = 'similar' | 'vector';

const indexName = ref<string>(props.initialIndex || props.table.vectorIndexes[0]?.IndexName || '');
const source = ref<Source>('similar');
const similarKey = ref<string>('');
const vectorText = ref<string>('');
const topK = ref<number | null>(5);
const filterValues = ref<Record<string, string>>({});

const candidates = ref<Record<string, unknown>[]>([]);
const loadingCandidates = ref(false);
const running = ref(false);
const error = ref<string | null>(null);
const result = ref<DynamoVectorSearchOutput | null>(null);
// The key the current results are "similar to" — named in the results header.
const resultSource = ref<string>('');

const index = computed<DynamoVectorIndex | undefined>(() =>
  props.table.vectorIndexes.find(i => i.IndexName === indexName.value),
);
const vectorAttr = computed(() => index.value?.VectorAttribute?.AttributeName || '');
const hashAttr = computed(
  () => index.value?.SearchSchema?.find(el => el.SearchSchemaElementType === 'HASH')?.AttributeName || '',
);
const filterAttrs = computed(() =>
  (index.value?.SearchSchema || [])
    .filter(el => el.SearchSchemaElementType === 'INLINE_FILTER')
    .map(el => el.AttributeName || '')
    .filter(Boolean),
);
const keyAttrs = computed(() =>
  props.table.keySchema.map(k => k.AttributeName).filter((n): n is string => !!n),
);

const indexOptions = computed(() =>
  props.table.vectorIndexes.map(i => ({ value: i.IndexName || '', label: i.IndexName || '' })),
);

// Labels are prose, so computed — they relabel on a language switch.
const sourceOptions = computed<TToggleGroupOption<Source>[]>(() => [
  { value: 'similar', label: t('dynamo.sourceSimilar') },
  { value: 'vector', label: t('dynamo.sourceVector') },
]);

// A readable name for an item in the picker: its key, plus the first
// "name-like" string attribute when there is one.
function itemLabel(item: Record<string, unknown>): string {
  const key = keyAttrs.value.map(k => String(item[k])).join(' · ');
  const name = ['name', 'title', 'label'].map(n => item[n]).find(v => typeof v === 'string');
  return name ? `${key} — ${name}` : key;
}

function keyOf(item: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(keyAttrs.value.map(k => [k, item[k]]));
}

const candidateOptions = computed<TComboboxOption[]>(() =>
  candidates.value
    .filter(item => Array.isArray(item[vectorAttr.value]))
    .map(item => ({
      value: JSON.stringify(keyOf(item)),
      label: itemLabel(item),
      description: hashAttr.value && item[hashAttr.value] !== undefined ? `${hashAttr.value}: ${String(item[hashAttr.value])}` : undefined,
    })),
);

async function loadCandidates() {
  loadingCandidates.value = true;
  try {
    const page = await api.scanDynamoTable(props.table.name, { limit: 200 });
    candidates.value = page.items;
  } catch (err: any) {
    error.value = err.message || t('dynamo.vectorSearchFailed');
  } finally {
    loadingCandidates.value = false;
  }
}

// Filter values are typed by AttributeDefinitions (an N partition is sent as a
// number) — the same coercion the items explorer applies to key values.
function coerce(attr: string, raw: string): unknown {
  const def = props.table.attributeDefinitions.find(a => a.AttributeName === attr);
  if (def?.AttributeType === 'N') {
    const n = Number(raw);
    if (Number.isNaN(n)) throw new Error(t('dynamo.errNotNumberFor', { value: raw, attr }));
    return n;
  }
  return raw;
}

function buildFilter(): Record<string, unknown> | undefined {
  const filter: Record<string, unknown> = {};
  for (const attr of [hashAttr.value, ...filterAttrs.value]) {
    const raw = (filterValues.value[attr] || '').trim();
    if (attr && raw) filter[attr] = coerce(attr, raw);
  }
  return Object.keys(filter).length ? filter : undefined;
}

function parseVector(): number[] {
  const dims = index.value?.Dimensions;
  let parsed: unknown;
  try {
    parsed = JSON.parse(vectorText.value);
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed) || parsed.some(n => typeof n !== 'number') || (dims && parsed.length !== dims)) {
    throw new Error(t('dynamo.errVectorJson', { dims: dims ?? '?' }));
  }
  return parsed as number[];
}

async function run(similarTo?: Record<string, unknown>) {
  error.value = null;
  try {
    const filter = buildFilter();
    const body: Parameters<typeof api.searchDynamoVectors>[1] = {
      indexName: indexName.value,
      topK: topK.value ?? undefined,
      filter,
    };
    if (similarTo) {
      body.similarTo = similarTo;
    } else if (source.value === 'similar') {
      if (!similarKey.value) throw new Error(t('dynamo.errPickItem'));
      body.similarTo = JSON.parse(similarKey.value);
    } else {
      if (hashAttr.value && !filter?.[hashAttr.value]) throw new Error(t('dynamo.errHashRequired', { attr: hashAttr.value }));
      body.vector = parseVector();
    }
    running.value = true;
    result.value = await api.searchDynamoVectors(props.table.name, body);
    resultSource.value = body.similarTo ? Object.values(body.similarTo).map(String).join(' · ') : '';
  } catch (err: any) {
    error.value = err.message || t('dynamo.vectorSearchFailed');
  } finally {
    running.value = false;
  }
}

// "More like this one": re-run with a result row as the query item.
function findSimilar(item: Record<string, unknown>) {
  source.value = 'similar';
  similarKey.value = JSON.stringify(keyOf(item));
  run(keyOf(item));
}

const scoreHint = computed(() => {
  switch (result.value?.distanceFunction ?? index.value?.DistanceFunction) {
    case 'EUCLIDEAN': return t('dynamo.scoreHintEuclidean');
    case 'DOT_PRODUCT': return t('dynamo.scoreHintDot');
    default: return t('dynamo.scoreHintCosine');
  }
});

// Under COSINE the score is a distance (1 − cos): 1 − score is the cosine
// similarity, a well-defined 0..1 bar for the positive half. The other two
// functions have no fixed range, so they get no bar rather than an invented one.
const showSimilarity = computed(() => (result.value?.distanceFunction ?? index.value?.DistanceFunction) === 'COSINE');

const resultAttrs = computed(() => {
  const set = new Set<string>();
  for (const r of result.value?.results || []) {
    Object.keys(r.item).forEach(k => { if (!keyAttrs.value.includes(k)) set.add(k); });
  }
  return Array.from(set).sort();
});

const columns = computed(() => [
  { key: 'rank', label: t('dynamo.colRank'), align: 'right' as const, width: '3rem' },
  { key: 'score', label: t('dynamo.colScore'), align: 'right' as const },
  ...(showSimilarity.value ? [{ key: 'similarity', label: t('dynamo.colSimilarity'), width: '9rem' }] : []),
  ...keyAttrs.value.map(name => ({ key: `__attr__${name}`, label: name })),
  ...resultAttrs.value.map(name => ({ key: `__attr__${name}`, label: name })),
  { key: 'actions', label: '', align: 'right' as const },
]);

const rows = computed(() =>
  (result.value?.results || []).map((r, i) => {
    const row: Record<string, unknown> = {
      __id: i,
      __raw: r.item,
      rank: i + 1,
      score: r.score,
      similarity: Math.max(0, Math.min(100, Math.round((1 - r.score) * 100))),
    };
    for (const name of [...keyAttrs.value, ...resultAttrs.value]) row[`__attr__${name}`] = r.item[name];
    return row;
  }),
);

function show(v: unknown): string {
  if (v === undefined) return '—';
  if (typeof v === 'object' && v !== null) return JSON.stringify(v).slice(0, 80);
  return String(v).slice(0, 80);
}

function rowLabel(row: Record<string, unknown>): string {
  return t('dynamo.findSimilarLabel', { key: itemLabel(row.__raw as Record<string, unknown>) });
}

watch(indexName, () => {
  filterValues.value = {};
  result.value = null;
});

loadCandidates();
</script>

<template>
  <TStack direction="vertical" gap="1rem">
    <TCard variant="outline">
      <template #header>
        <TStack direction="vertical" gap="0.125rem">
          <TText weight="semibold">{{ t('dynamo.vectorSearchTitle') }}</TText>
          <TText tone="muted" size="xs">{{ t('dynamo.vectorSearchDesc') }}</TText>
        </TStack>
      </template>

      <TStack direction="vertical" gap="1rem">
        <TStack direction="horizontal" gap="1rem" align="end">
          <TStackItem :grow="2" basis="0">
            <TFormField :label="t('dynamo.vectorIndex')">
              <TSelect v-model="indexName" :options="indexOptions" />
            </TFormField>
          </TStackItem>
          <TStackItem :grow="1" basis="0">
            <TFormField :label="t('dynamo.topK')">
              <TNumberInput v-model="topK" :min="1" :max="100" />
            </TFormField>
          </TStackItem>
        </TStack>

        <TStack v-if="index" direction="horizontal" gap="0.375rem" wrap>
          <TTag size="sm" variant="soft">{{ t('dynamo.vectorAttribute') }}: {{ vectorAttr }}</TTag>
          <TTag size="sm" variant="soft">{{ t('dynamo.dimensions') }}: {{ index.Dimensions }}</TTag>
          <TTag size="sm" variant="soft">{{ index.DistanceFunction }}</TTag>
          <TTag v-if="hashAttr" size="sm" variant="soft" tone="accent">{{ hashAttr }} (HASH)</TTag>
          <TTag v-for="f in filterAttrs" :key="f" size="sm" variant="soft">{{ f }} (INLINE_FILTER)</TTag>
        </TStack>

        <TDivider />

        <!-- The wrapper keeps the toggle group at its intrinsic width. -->
        <TStackItem align="start">
          <TToggleGroup v-model="source" :options="sourceOptions" size="md" />
        </TStackItem>

        <TFormField v-if="source === 'similar'" :label="t('dynamo.similarItem')">
          <TCombobox
            v-model="similarKey"
            :options="candidateOptions"
            :loading="loadingCandidates"
            :placeholder="t('dynamo.similarItemPlaceholder')"
            :empty-text="t('dynamo.similarItemEmpty')"
          />
        </TFormField>

        <TFormField v-else :label="t('dynamo.vectorJson', { dims: index?.Dimensions ?? '?' })">
          <TTextarea v-model="vectorText" family="mono" :rows="3" placeholder="[0.12, -0.03, …]" />
        </TFormField>

        <TStack v-if="hashAttr || filterAttrs.length" direction="horizontal" gap="1rem" wrap>
          <TStackItem v-if="hashAttr" :grow="1" basis="0" min-width="12rem">
            <TFormField
              :label="source === 'similar'
                ? t('dynamo.filterHashFromItem', { attr: hashAttr })
                : t('dynamo.filterHash', { attr: hashAttr })"
            >
              <TInput v-model="filterValues[hashAttr]" :placeholder="t('dynamo.filterValuePlaceholder')" />
            </TFormField>
          </TStackItem>
          <TStackItem v-for="f in filterAttrs" :key="f" :grow="1" basis="0" min-width="12rem">
            <TFormField :label="t('dynamo.filterInline', { attr: f })">
              <TInput v-model="filterValues[f]" :placeholder="t('dynamo.filterValuePlaceholder')" />
            </TFormField>
          </TStackItem>
        </TStack>
      </TStack>

      <template #footer>
        <TStack direction="horizontal" gap="0.5rem" align="center">
          <TButton variant="solid" :loading="running" @click="run()">{{ t('dynamo.searchRun') }}</TButton>
          <TText tone="muted" size="xs">{{ scoreHint }}</TText>
        </TStack>
      </template>
    </TCard>

    <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
      {{ error }}
    </TAlert>

    <TCard variant="outline">
      <template #header>
        <TStack direction="vertical" gap="0.125rem">
          <TText weight="semibold">
            {{ t('dynamo.vectorResultsTitle', { index: result?.indexName || indexName }) }}
            <template v-if="result">
              – {{ result.results.length === 1
                ? t('dynamo.vectorResultsOne', { count: result.results.length })
                : t('dynamo.vectorResultsOther', { count: result.results.length }) }}
            </template>
          </TText>
          <TText v-if="result && resultSource" tone="muted" size="xs">
            {{ t('dynamo.similarToSource', { key: resultSource }) }}
          </TText>
        </TStack>
      </template>

      <TStack v-if="running && !result" direction="horizontal" justify="center" align="center">
        <TSpinner :label="t('dynamo.searchingVectors')" />
      </TStack>

      <TEmptyState
        v-else-if="!result"
        :title="t('dynamo.vectorIdleTitle')"
        :description="t('dynamo.vectorIdleDesc')"
      />

      <TEmptyState
        v-else-if="!result.results.length"
        :title="t('dynamo.vectorNoResultsTitle')"
        :description="t('dynamo.vectorNoResultsDesc')"
      />

      <TTable
        v-else
        :columns="columns"
        :rows="rows"
        row-key="__id"
        :aria-label="t('dynamo.vectorResultsAriaLabel')"
      >
        <template #cell-rank="{ row }">
          <TText tone="muted">{{ row.rank }}</TText>
        </template>
        <template #cell-score="{ row }">
          <TText family="mono" weight="semibold">{{ Number(row.score).toFixed(4) }}</TText>
        </template>
        <template #cell-similarity="{ row }">
          <TProgress :value="Number(row.similarity)" :label="`${row.similarity}%`" size="sm" />
        </template>
        <template
          v-for="name in [...keyAttrs, ...resultAttrs]"
          :key="`v-${name}`"
          #[`cell-__attr__${name}`]="{ row }"
        >
          <TText family="mono" size="sm">{{ show((row as any)[`__attr__${name}`]) }}</TText>
        </template>
        <template #cell-actions="{ row }">
          <TButton
            size="sm"
            variant="ghost"
            :aria-label="rowLabel(row)"
            @click="findSimilar(row.__raw as Record<string, unknown>)"
          >
            {{ t('dynamo.findSimilar') }}
          </TButton>
        </template>
      </TTable>
    </TCard>
  </TStack>
</template>
