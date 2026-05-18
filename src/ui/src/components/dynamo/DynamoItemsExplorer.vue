<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import {
  TCard, TButton, TBadge, TStack, TTable, TEmptyState, TSpinner, TAlert,
  TInput, TSelect, TSelectableList, TDivider, TConfirmDialog, useToast,
  TToggleGroup,
} from '@treeui/vue';
import { api } from '../../services/api';
import type {
  DynamoTableDetail, DynamoScanQueryInput, DynamoScanQueryOutput,
} from '../../services/api';
import DynamoItemEditor from './DynamoItemEditor.vue';

const props = defineProps<{ table: DynamoTableDetail }>();

const toast = useToast();

type Mode = 'scan' | 'query';

interface Condition {
  attr: string;
  op: string;
  value: string;
}

const mode = ref<Mode>('scan');
const indexName = ref<string>('');
const keyConditions = ref<Condition[]>([]);
const filterConditions = ref<Condition[]>([]);
const limit = ref<number>(50);

const items = ref<Record<string, unknown>[]>([]);
const lastEvaluatedKey = ref<Record<string, unknown> | undefined>(undefined);
const scannedCount = ref<number | undefined>(undefined);
const running = ref(false);
const error = ref<string | null>(null);

// Modal state
const editorOpen = ref(false);
const editorMode = ref<'create' | 'edit' | 'view'>('view');
const editorItem = ref<Record<string, unknown> | null>(null);
const editorOriginalKey = ref<Record<string, unknown> | null>(null);

const confirmDeleteOpen = ref(false);
const pendingDelete = ref<Record<string, unknown> | null>(null);

const filterOps: { value: string; label: string }[] = [
  { value: '=', label: 'equals' },
  { value: '<>', label: 'not equals' },
  { value: '<', label: 'less than' },
  { value: '<=', label: 'less or equal' },
  { value: '>', label: 'greater than' },
  { value: '>=', label: 'greater or equal' },
  { value: 'begins_with', label: 'begins with' },
  { value: 'contains', label: 'contains' },
  { value: 'attribute_exists', label: 'exists' },
  { value: 'attribute_not_exists', label: 'does not exist' },
];

// Query key-condition supports only =, <, <=, >, >=, between, begins_with — and =/begins_with
// for the sort key. To keep it ergonomic we expose the common ones.
const keyConditionOps: { value: string; label: string }[] = [
  { value: '=', label: 'equals' },
  { value: '<', label: 'less than' },
  { value: '<=', label: 'less or equal' },
  { value: '>', label: 'greater than' },
  { value: '>=', label: 'greater or equal' },
  { value: 'begins_with', label: 'begins with' },
];

const modeOptions = [
  { value: 'scan', label: 'Scan' },
  { value: 'query', label: 'Query' },
];

const indexOptions = computed(() => {
  const opts: { value: string; label: string }[] = [
    { value: '', label: 'Table (primary key)' },
  ];
  for (const gsi of props.table.gsis || []) {
    if (gsi.IndexName) opts.push({ value: gsi.IndexName, label: `GSI · ${gsi.IndexName}` });
  }
  for (const lsi of props.table.lsis || []) {
    if (lsi.IndexName) opts.push({ value: lsi.IndexName, label: `LSI · ${lsi.IndexName}` });
  }
  return opts;
});

const activeKeySchema = computed(() => {
  if (!indexName.value) return props.table.keySchema;
  const idx =
    props.table.gsis.find(g => g.IndexName === indexName.value) ||
    props.table.lsis.find(l => l.IndexName === indexName.value);
  return idx?.KeySchema || props.table.keySchema;
});

const keyAttrNames = computed(() =>
  (activeKeySchema.value || []).map(k => k.AttributeName).filter((n): n is string => !!n),
);

const allAttrNames = computed(() => {
  const set = new Set<string>();
  for (const item of items.value) {
    Object.keys(item).forEach(k => set.add(k));
  }
  // Always include declared key/attr names so the dropdowns aren't empty before first run.
  (props.table.attributeDefinitions || []).forEach(a => {
    if (a.AttributeName) set.add(a.AttributeName);
  });
  return Array.from(set).sort();
});

const columns = computed(() => {
  const keyCols = keyAttrNames.value.map(name => ({ key: `__attr__${name}`, label: name }));
  return [
    ...keyCols,
    { key: '__preview', label: 'Other attributes' },
    { key: '__actions', label: '', align: 'right' as const },
  ];
});

const rows = computed(() =>
  items.value.map((item, i) => {
    const row: Record<string, unknown> = { __id: i };
    for (const name of keyAttrNames.value) {
      row[`__attr__${name}`] = item[name];
    }
    const otherEntries = Object.entries(item).filter(([k]) => !keyAttrNames.value.includes(k));
    row.__preview = otherEntries
      .slice(0, 4)
      .map(([k, v]) => `${k}: ${stringifyShort(v)}`)
      .join(' · ') + (otherEntries.length > 4 ? ` · +${otherEntries.length - 4} more` : '');
    row.__raw = item;
    return row;
  }),
);

function stringifyShort(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 60);
  return String(v).slice(0, 60);
}

function inferValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    try { return JSON.parse(trimmed); } catch { /* fall through */ }
  }
  return trimmed;
}

function buildExpression(
  conditions: Condition[],
  prefix: string,
): { expression: string; names: Record<string, string>; values: Record<string, unknown> } {
  const expressions: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  conditions.forEach((c, i) => {
    if (!c.attr) return;
    const nameKey = `#${prefix}n${i}`;
    const valueKey = `:${prefix}v${i}`;
    names[nameKey] = c.attr;
    switch (c.op) {
      case 'attribute_exists':
        expressions.push(`attribute_exists(${nameKey})`);
        break;
      case 'attribute_not_exists':
        expressions.push(`attribute_not_exists(${nameKey})`);
        break;
      case 'begins_with':
        values[valueKey] = inferValue(c.value);
        expressions.push(`begins_with(${nameKey}, ${valueKey})`);
        break;
      case 'contains':
        values[valueKey] = inferValue(c.value);
        expressions.push(`contains(${nameKey}, ${valueKey})`);
        break;
      default:
        values[valueKey] = inferValue(c.value);
        expressions.push(`${nameKey} ${c.op} ${valueKey}`);
    }
  });
  return { expression: expressions.join(' AND '), names, values };
}

function mergeMaps<T>(a: Record<string, T>, b: Record<string, T>): Record<string, T> {
  return { ...a, ...b };
}

function buildInput(continueFrom?: Record<string, unknown>): DynamoScanQueryInput {
  const filter = buildExpression(filterConditions.value, 'f');
  const input: DynamoScanQueryInput = {
    indexName: indexName.value || undefined,
    limit: limit.value > 0 ? limit.value : undefined,
    exclusiveStartKey: continueFrom,
  };
  let names: Record<string, string> = filter.names;
  let values: Record<string, unknown> = filter.values;
  if (filter.expression) input.filterExpression = filter.expression;

  if (mode.value === 'query') {
    const key = buildExpression(keyConditions.value, 'k');
    if (!key.expression) {
      throw new Error('Query requires at least one key condition');
    }
    input.keyConditionExpression = key.expression;
    names = mergeMaps(names, key.names);
    values = mergeMaps(values, key.values);
  }

  if (Object.keys(names).length) input.expressionAttributeNames = names;
  if (Object.keys(values).length) input.expressionAttributeValues = values;
  return input;
}

async function run(continueFrom?: Record<string, unknown>) {
  running.value = true;
  error.value = null;
  try {
    const input = buildInput(continueFrom);
    const res: DynamoScanQueryOutput =
      mode.value === 'scan'
        ? await api.scanDynamoTable(props.table.name, input)
        : await api.queryDynamoTable(props.table.name, input);
    if (continueFrom) {
      items.value = [...items.value, ...res.items];
    } else {
      items.value = res.items;
    }
    lastEvaluatedKey.value = res.lastEvaluatedKey;
    scannedCount.value = res.scannedCount;
  } catch (err: any) {
    error.value = err.message || 'Request failed';
  } finally {
    running.value = false;
  }
}

function loadMore() {
  if (lastEvaluatedKey.value) run(lastEvaluatedKey.value);
}

function addFilter() {
  filterConditions.value.push({
    attr: allAttrNames.value[0] || '',
    op: '=',
    value: '',
  });
}

function addKeyCondition() {
  if (keyConditions.value.length >= 2) return; // PK + SK max
  const next = keyAttrNames.value[keyConditions.value.length];
  keyConditions.value.push({ attr: next || '', op: '=', value: '' });
}

function removeFilter(i: number) {
  filterConditions.value.splice(i, 1);
}

function removeKeyCondition(i: number) {
  keyConditions.value.splice(i, 1);
}

function extractKey(item: Record<string, unknown>): Record<string, unknown> {
  const key: Record<string, unknown> = {};
  for (const k of props.table.keySchema) {
    if (k.AttributeName) key[k.AttributeName] = item[k.AttributeName];
  }
  return key;
}

function openCreate() {
  editorMode.value = 'create';
  editorItem.value = null;
  editorOriginalKey.value = null;
  editorOpen.value = true;
}

function openEdit(item: Record<string, unknown>) {
  editorMode.value = 'edit';
  editorItem.value = item;
  editorOriginalKey.value = extractKey(item);
  editorOpen.value = true;
}

function openView(item: Record<string, unknown>) {
  editorMode.value = 'view';
  editorItem.value = item;
  editorOriginalKey.value = null;
  editorOpen.value = true;
}

function askDelete(item: Record<string, unknown>) {
  pendingDelete.value = extractKey(item);
  confirmDeleteOpen.value = true;
}

async function doDelete() {
  if (!pendingDelete.value) return;
  try {
    await api.deleteDynamoItem(props.table.name, pendingDelete.value);
    toast.add({ title: 'Item deleted', variant: 'info' });
    await run();
  } catch (err: any) {
    toast.add({ title: 'Delete failed', description: err.message, variant: 'danger' });
  } finally {
    confirmDeleteOpen.value = false;
    pendingDelete.value = null;
  }
}

function onSaved() {
  run();
}

// Initial load
run();

// Reset paging when mode or index changes
watch(() => [mode.value, indexName.value], () => {
  items.value = [];
  lastEvaluatedKey.value = undefined;
  keyConditions.value = [];
});
</script>

<template>
  <TStack direction="vertical" gap="1rem">
    <TCard variant="outline">
      <template #header>
        <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
          <strong>Explore items</strong>
          <TStack direction="horizontal" gap="0.5rem">
            <TToggleGroup
              v-model="mode"
              :options="modeOptions"
              size="sm"
            />
            <TButton size="sm" variant="solid" :loading="running" @click="run()">
              Run
            </TButton>
            <TButton size="sm" variant="soft" @click="openCreate">
              Create item
            </TButton>
          </TStack>
        </TStack>
      </template>

      <TStack direction="vertical" gap="0.75rem">
        <TStack direction="horizontal" gap="0.5rem" align="center" wrap>
          <span class="muted" style="min-width: 4rem;">Index</span>
          <TSelect v-model="indexName" :options="indexOptions" size="sm" style="min-width: 16rem;" />
          <span class="muted" style="margin-left: 0.5rem;">Limit</span>
          <TInput v-model.number="limit" type="number" size="sm" style="width: 6rem;" />
        </TStack>

        <TDivider v-if="mode === 'query'" />

        <TStack v-if="mode === 'query'" direction="vertical" gap="0.5rem">
          <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
            <strong style="font-size: 0.85rem;">Key conditions</strong>
            <TButton
              size="sm"
              variant="ghost"
              :disabled="keyConditions.length >= 2"
              @click="addKeyCondition"
            >
              Add condition
            </TButton>
          </TStack>

          <TEmptyState
            v-if="!keyConditions.length"
            title="No key conditions yet"
            description="Query requires at least one condition on the partition key."
            size="sm"
          />

          <TStack v-else direction="vertical" gap="0.375rem">
            <TStack
              v-for="(c, i) in keyConditions"
              :key="`kc-${i}`"
              direction="horizontal"
              gap="0.5rem"
              align="center"
            >
              <TSelect
                v-model="c.attr"
                :options="keyAttrNames.map(n => ({ value: n, label: n }))"
                size="sm"
                style="min-width: 12rem;"
              />
              <TSelect
                v-model="c.op"
                :options="keyConditionOps"
                size="sm"
                style="min-width: 10rem;"
              />
              <TInput v-model="c.value" placeholder="value" size="sm" style="flex: 1;" />
              <TButton size="sm" variant="ghost" @click="removeKeyCondition(i)">×</TButton>
            </TStack>
          </TStack>
        </TStack>

        <TDivider />

        <TStack direction="vertical" gap="0.5rem">
          <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
            <strong style="font-size: 0.85rem;">Filters</strong>
            <TButton size="sm" variant="ghost" @click="addFilter">Add filter</TButton>
          </TStack>

          <TStack
            v-if="filterConditions.length"
            direction="vertical"
            gap="0.375rem"
          >
            <TStack
              v-for="(c, i) in filterConditions"
              :key="`fc-${i}`"
              direction="horizontal"
              gap="0.5rem"
              align="center"
            >
              <TInput
                v-model="c.attr"
                placeholder="attribute"
                size="sm"
                style="min-width: 12rem;"
                :list="`attr-list-${i}`"
              />
              <datalist :id="`attr-list-${i}`">
                <option v-for="n in allAttrNames" :key="n" :value="n" />
              </datalist>
              <TSelect
                v-model="c.op"
                :options="filterOps"
                size="sm"
                style="min-width: 12rem;"
              />
              <TInput
                v-if="c.op !== 'attribute_exists' && c.op !== 'attribute_not_exists'"
                v-model="c.value"
                placeholder="value (auto-typed)"
                size="sm"
                style="flex: 1;"
              />
              <TButton size="sm" variant="ghost" @click="removeFilter(i)">×</TButton>
            </TStack>
          </TStack>

          <span v-else class="muted" style="font-size: 0.75rem;">
            No filters. Numbers and booleans are auto-detected from the value text; wrap strings in quotes if you need to force a string type.
          </span>
        </TStack>
      </TStack>
    </TCard>

    <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
      {{ error }}
    </TAlert>

    <TCard variant="outline">
      <template #header>
        <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
          <strong>Results</strong>
          <TStack direction="horizontal" gap="0.5rem">
            <TBadge tone="info" variant="soft">{{ items.length }} loaded</TBadge>
            <TBadge v-if="scannedCount !== undefined" tone="neutral" variant="soft">
              scanned: {{ scannedCount }}
            </TBadge>
            <TBadge v-if="lastEvaluatedKey" tone="warning" variant="soft">more available</TBadge>
          </TStack>
        </TStack>
      </template>

      <div v-if="running && !items.length" style="display: flex; justify-content: center; padding: 2rem;">
        <TSpinner label="Running..." />
      </div>

      <TEmptyState
        v-else-if="!items.length"
        title="No items"
        description="Run the operation to load items."
      />

      <TTable v-else :columns="columns" :rows="rows">
        <template v-for="name in keyAttrNames" :key="name" #[`cell-__attr__${name}`]="{ row }">
          <span class="mono">{{ stringifyShort((row as any)[`__attr__${name}`]) }}</span>
        </template>

        <template #cell-__preview="{ row }">
          <span class="muted mono" style="font-size: 0.75rem;">{{ row.__preview }}</span>
        </template>

        <template #cell-__actions="{ row }">
          <TStack direction="horizontal" gap="0.25rem" justify="flex-end">
            <TButton size="sm" variant="ghost" @click="openView((row as any).__raw)">View</TButton>
            <TButton size="sm" variant="ghost" @click="openEdit((row as any).__raw)">Edit</TButton>
            <TButton size="sm" variant="ghost" tone="danger" @click="askDelete((row as any).__raw)">Delete</TButton>
          </TStack>
        </template>
      </TTable>

      <template v-if="lastEvaluatedKey" #footer>
        <TStack direction="horizontal" justify="center">
          <TButton size="sm" variant="soft" :loading="running" @click="loadMore">
            Load more
          </TButton>
        </TStack>
      </template>
    </TCard>

    <DynamoItemEditor
      v-model:open="editorOpen"
      :table-name="props.table.name"
      :mode="editorMode"
      :item="editorItem"
      :original-key="editorOriginalKey"
      @saved="onSaved"
    />

    <TConfirmDialog
      v-model:open="confirmDeleteOpen"
      title="Delete item"
      :description="`Delete this item from ${props.table.name}? This cannot be undone.`"
      confirm-label="Delete"
      cancel-label="Cancel"
      tone="danger"
      @confirm="doDelete"
    />
  </TStack>
</template>
