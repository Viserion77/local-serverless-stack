<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import {
  TCard, TButton, TStack, TTable, TEmptyState, TSpinner, TAlert,
  TInput, TSelect, TDivider, TConfirmDialog, useToast, TFormField,
  TToggleGroup, TLink, TCheckbox, TText, TIcon,
} from '@treeui/vue';
import { api } from '../../services/api';
import type {
  DynamoTableDetail, DynamoScanQueryInput, DynamoScanQueryOutput,
} from '../../services/api';
import DynamoItemEditor from './DynamoItemEditor.vue';
import { useI18n } from '../../i18n';

const props = defineProps<{ table: DynamoTableDetail }>();

const { t } = useI18n();
const toast = useToast();

type Mode = 'scan' | 'query';
type FilterType = 'String' | 'Number' | 'Boolean' | 'Null';

interface Filter {
  attr: string;
  op: string;
  type: FilterType;
  value: string;
}

const mode = ref<Mode>('scan');
const indexName = ref<string>('');
const limit = ref<number>(50);

// Query — single partition + single sort condition, AWS-style.
const pkValue = ref<string>('');
const skOperator = ref<string>('=');
const skValue = ref<string>('');
const skValue2 = ref<string>(''); // second value, used by the BETWEEN operator
const sortDescending = ref<boolean>(false);

const filters = ref<Filter[]>([]);
const filtersExpanded = ref<boolean>(false);

const items = ref<Record<string, unknown>[]>([]);
const lastEvaluatedKey = ref<Record<string, unknown> | undefined>(undefined);
const scannedCount = ref<number | undefined>(undefined);
const startedAt = ref<Date | null>(null);
const running = ref(false);
const error = ref<string | null>(null);
const statusVisible = ref(false);

const editorOpen = ref(false);
const editorMode = ref<'create' | 'edit' | 'view'>('view');
const editorItem = ref<Record<string, unknown> | null>(null);
const editorOriginalKey = ref<Record<string, unknown> | null>(null);

const confirmDeleteOpen = ref(false);
const pendingDelete = ref<Record<string, unknown> | null>(null);

// `Scan` and `Query` are the DynamoDB API operations — left in English so the
// toggle names the SDK call the dashboard is about to make.
const modeOptions = [
  { value: 'scan', label: 'Scan' },
  { value: 'query', label: 'Query' },
];

// Operator labels are prose, so they are computed: t() has to run again when the
// locale changes for the selects to relabel themselves.
const skOperators = computed<{ value: string; label: string }[]>(() => [
  { value: '=', label: t('dynamo.opEq') },
  { value: '<=', label: t('dynamo.opLte') },
  { value: '<', label: t('dynamo.opLt') },
  { value: '>=', label: t('dynamo.opGte') },
  { value: '>', label: t('dynamo.opGt') },
  { value: 'between', label: t('dynamo.opBetween') },
  { value: 'begins_with', label: t('dynamo.opBeginsWith') },
]);

const filterOps = computed<{ value: string; label: string }[]>(() => [
  { value: '=', label: t('dynamo.opEq') },
  { value: '<>', label: t('dynamo.opNeq') },
  { value: '<', label: t('dynamo.opLt') },
  { value: '<=', label: t('dynamo.opLte') },
  { value: '>', label: t('dynamo.opGt') },
  { value: '>=', label: t('dynamo.opGte') },
  { value: 'begins_with', label: t('dynamo.opBeginsWith') },
  { value: 'contains', label: t('dynamo.opContains') },
  { value: 'attribute_exists', label: t('dynamo.opExists') },
  { value: 'attribute_not_exists', label: t('dynamo.opNotExists') },
]);

// Attribute types keep their DynamoDB names (String/Number/Boolean/Null) —
// they are API values, not vocabulary.
const filterTypeOptions: { value: FilterType; label: string }[] = [
  { value: 'String', label: 'String' },
  { value: 'Number', label: 'Number' },
  { value: 'Boolean', label: 'Boolean' },
  { value: 'Null', label: 'Null' },
];

const indexOptions = computed(() => {
  const opts: { value: string; label: string }[] = [
    { value: '', label: t('dynamo.optionTable', { name: props.table.name }) },
  ];
  for (const gsi of props.table.gsis || []) {
    if (gsi.IndexName) {
      opts.push({ value: gsi.IndexName, label: t('dynamo.optionIndex', { name: gsi.IndexName }) });
    }
  }
  for (const lsi of props.table.lsis || []) {
    if (lsi.IndexName) {
      opts.push({ value: lsi.IndexName, label: t('dynamo.optionIndex', { name: lsi.IndexName }) });
    }
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

const pkAttr = computed(
  () => activeKeySchema.value?.find(k => k.KeyType === 'HASH')?.AttributeName || '',
);
const skAttr = computed(
  () => activeKeySchema.value?.find(k => k.KeyType === 'RANGE')?.AttributeName || '',
);

const keyAttrNames = computed(() =>
  (activeKeySchema.value || []).map(k => k.AttributeName).filter((n): n is string => !!n),
);

const nonKeyAttrsInItems = computed(() => {
  const set = new Set<string>();
  for (const item of items.value) {
    Object.keys(item).forEach(k => {
      if (!keyAttrNames.value.includes(k)) set.add(k);
    });
  }
  return Array.from(set).sort();
});

function attrTypeLabel(name: string): string | null {
  const def = props.table.attributeDefinitions.find(a => a.AttributeName === name);
  if (!def?.AttributeType) return null;
  if (def.AttributeType === 'S') return 'String';
  if (def.AttributeType === 'N') return 'Number';
  if (def.AttributeType === 'B') return 'Binary';
  return def.AttributeType;
}

function columnLabel(name: string, isPk?: boolean, isSk?: boolean): string {
  const type = attrTypeLabel(name);
  if (isPk) return type ? `${name} (${type}, PK)` : `${name} (PK)`;
  if (isSk) return type ? `${name} (${type}, SK)` : `${name} (SK)`;
  return type ? `${name} (${type})` : name;
}

const columns = computed(() => {
  const keyCols = keyAttrNames.value.map((name, idx) => ({
    key: `__attr__${name}`,
    label: columnLabel(name, idx === 0, idx === 1),
  }));
  const otherCols = nonKeyAttrsInItems.value.map(name => ({
    key: `__attr__${name}`,
    label: columnLabel(name),
  }));
  return [...keyCols, ...otherCols];
});

const rows = computed(() =>
  items.value.map((item, i) => {
    const row: Record<string, unknown> = { __id: i, __raw: item };
    for (const name of keyAttrNames.value) row[`__attr__${name}`] = item[name];
    for (const name of nonKeyAttrsInItems.value) row[`__attr__${name}`] = item[name];
    return row;
  }),
);

function stringifyShort(v: unknown): string {
  if (v === undefined) return '—';
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 80);
  return String(v).slice(0, 80);
}

function coerceByType(raw: string, type: FilterType): unknown {
  switch (type) {
    case 'Number': {
      const n = Number(raw);
      if (Number.isNaN(n)) throw new Error(t('dynamo.errNotNumber', { value: raw }));
      return n;
    }
    case 'Boolean':
      return raw === 'true' || raw === '1';
    case 'Null':
      return null;
    case 'String':
    default:
      return raw;
  }
}

function coerceByAttrType(raw: string, name: string): unknown {
  const def = props.table.attributeDefinitions.find(a => a.AttributeName === name);
  if (def?.AttributeType === 'N') {
    const n = Number(raw);
    if (Number.isNaN(n)) throw new Error(t('dynamo.errNotNumberFor', { value: raw, attr: name }));
    return n;
  }
  return raw;
}

function buildQuery(): { keyExpr: string; names: Record<string, string>; values: Record<string, unknown> } {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  if (!pkAttr.value) throw new Error(t('dynamo.errNoPartitionKey'));
  if (!pkValue.value) throw new Error(t('dynamo.errPkRequired', { attr: pkAttr.value }));

  names['#pk'] = pkAttr.value;
  values[':pkv'] = coerceByAttrType(pkValue.value, pkAttr.value);
  let keyExpr = '#pk = :pkv';

  if (skAttr.value && skValue.value) {
    names['#sk'] = skAttr.value;
    if (skOperator.value === 'between') {
      if (!skValue2.value) throw new Error(t('dynamo.errBetweenTwoValues'));
      values[':skv1'] = coerceByAttrType(skValue.value, skAttr.value);
      values[':skv2'] = coerceByAttrType(skValue2.value, skAttr.value);
      keyExpr += ' AND #sk BETWEEN :skv1 AND :skv2';
    } else if (skOperator.value === 'begins_with') {
      values[':skv'] = coerceByAttrType(skValue.value, skAttr.value);
      keyExpr += ' AND begins_with(#sk, :skv)';
    } else {
      values[':skv'] = coerceByAttrType(skValue.value, skAttr.value);
      keyExpr += ` AND #sk ${skOperator.value} :skv`;
    }
  }

  return { keyExpr, names, values };
}

function buildFilter(): { expr: string; names: Record<string, string>; values: Record<string, unknown> } {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const parts: string[] = [];
  filters.value.forEach((f, i) => {
    if (!f.attr) return;
    const nameK = `#fn${i}`;
    const valueK = `:fv${i}`;
    names[nameK] = f.attr;
    if (f.op === 'attribute_exists') { parts.push(`attribute_exists(${nameK})`); return; }
    if (f.op === 'attribute_not_exists') { parts.push(`attribute_not_exists(${nameK})`); return; }
    values[valueK] = coerceByType(f.value, f.type);
    if (f.op === 'begins_with') parts.push(`begins_with(${nameK}, ${valueK})`);
    else if (f.op === 'contains') parts.push(`contains(${nameK}, ${valueK})`);
    else parts.push(`${nameK} ${f.op} ${valueK}`);
  });
  return { expr: parts.join(' AND '), names, values };
}

function buildInput(continueFrom?: Record<string, unknown>): DynamoScanQueryInput {
  const filter = buildFilter();
  const input: DynamoScanQueryInput = {
    indexName: indexName.value || undefined,
    limit: limit.value > 0 ? limit.value : undefined,
    exclusiveStartKey: continueFrom,
  };
  let names = filter.names;
  let values = filter.values;
  if (filter.expr) input.filterExpression = filter.expr;

  if (mode.value === 'query') {
    const q = buildQuery();
    input.keyConditionExpression = q.keyExpr;
    names = { ...names, ...q.names };
    values = { ...values, ...q.values };
    if (sortDescending.value) input.scanIndexForward = false;
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
    if (continueFrom) items.value = [...items.value, ...res.items];
    else {
      items.value = res.items;
      startedAt.value = new Date();
    }
    lastEvaluatedKey.value = res.lastEvaluatedKey;
    scannedCount.value = res.scannedCount;
    statusVisible.value = true;
  } catch (err: any) {
    error.value = err.message || t('dynamo.requestFailed');
  } finally {
    running.value = false;
  }
}

function reset() {
  pkValue.value = '';
  skOperator.value = '=';
  skValue.value = '';
  skValue2.value = '';
  sortDescending.value = false;
  filters.value = [];
  items.value = [];
  lastEvaluatedKey.value = undefined;
  scannedCount.value = undefined;
  statusVisible.value = false;
  error.value = null;
}

function nextPage() {
  if (lastEvaluatedKey.value) run(lastEvaluatedKey.value);
}

function addFilter() {
  filters.value.push({ attr: '', op: '=', type: 'String', value: '' });
  filtersExpanded.value = true;
}

function removeFilter(i: number) {
  filters.value.splice(i, 1);
}

function extractKey(item: Record<string, unknown>): Record<string, unknown> {
  const key: Record<string, unknown> = {};
  for (const k of props.table.keySchema) {
    if (k.AttributeName) key[k.AttributeName] = item[k.AttributeName];
  }
  return key;
}

function stubFromKeySchema(): Record<string, unknown> {
  const stub: Record<string, unknown> = {};
  for (const k of props.table.keySchema) {
    if (!k.AttributeName) continue;
    const def = props.table.attributeDefinitions.find(a => a.AttributeName === k.AttributeName);
    stub[k.AttributeName] = def?.AttributeType === 'N' ? 0 : '';
  }
  return stub;
}

function openCreate() {
  editorMode.value = 'create';
  editorItem.value = stubFromKeySchema();
  editorOriginalKey.value = null;
  editorOpen.value = true;
}

function openView(item: Record<string, unknown>) {
  editorMode.value = 'view';
  editorItem.value = item;
  editorOriginalKey.value = null;
  editorOpen.value = true;
}

function requestEditFromView() {
  if (!editorItem.value) return;
  editorOriginalKey.value = extractKey(editorItem.value);
  editorMode.value = 'edit';
}

function requestCloneFromView() {
  if (!editorItem.value) return;
  const cloned: Record<string, unknown> = { ...editorItem.value };
  for (const k of props.table.keySchema) {
    if (!k.AttributeName) continue;
    const def = props.table.attributeDefinitions.find(a => a.AttributeName === k.AttributeName);
    cloned[k.AttributeName] = def?.AttributeType === 'N' ? 0 : '';
  }
  editorItem.value = cloned;
  editorOriginalKey.value = null;
  editorMode.value = 'create';
}

function requestDeleteFromView() {
  if (!editorItem.value) return;
  pendingDelete.value = extractKey(editorItem.value);
  confirmDeleteOpen.value = true;
}

async function doDelete() {
  if (!pendingDelete.value) return;
  try {
    await api.deleteDynamoItem(props.table.name, pendingDelete.value);
    toast.add({ title: t('dynamo.itemDeleted'), variant: 'info' });
    editorOpen.value = false;
    await run();
  } catch (err: any) {
    toast.add({ title: t('dynamo.deleteFailed'), description: err.message, variant: 'danger' });
  } finally {
    confirmDeleteOpen.value = false;
    pendingDelete.value = null;
  }
}

function onSaved() { run(); }

const statusInfo = computed(() => {
  const returned = items.value.length;
  const scanned = scannedCount.value ?? returned;
  const efficiency = scanned > 0 ? Math.round((returned / scanned) * 100) : 100;
  return { returned, scanned, efficiency, finished: !lastEvaluatedKey.value };
});

run();

// Reset paging + cached items when mode or index changes (key schema may differ).
watch(() => [mode.value, indexName.value], () => {
  items.value = [];
  lastEvaluatedKey.value = undefined;
  scannedCount.value = undefined;
  statusVisible.value = false;
});
</script>

<template>
  <TStack direction="vertical" gap="1rem">
    <TCard variant="outline">
      <template #header>
        <TText weight="semibold">{{ t('dynamo.explorerTitle') }}</TText>
      </template>

      <TStack direction="vertical" gap="1rem">
        <div style="width: 100%;">
          <TToggleGroup
            v-model="mode"
            :options="modeOptions"
            size="md"
          />
        </div>

        <TStack direction="horizontal" gap="1rem">
          <TFormField :label="t('dynamo.selectTableOrIndex')" style="flex: 1;">
            <TSelect v-model="indexName" :options="indexOptions" />
          </TFormField>
          <TFormField :label="t('dynamo.selectProjection')" style="flex: 1;">
            <TSelect
              :model-value="'All attributes'"
              :options="[{ value: 'All attributes', label: t('dynamo.allAttributes') }]"
              disabled
            />
          </TFormField>
        </TStack>

        <template v-if="mode === 'query'">
          <TDivider />
          <TStack direction="vertical" gap="0.5rem">
            <TText weight="semibold" style="font-size: 0.9rem;">{{ t('dynamo.partitionKey') }}</TText>
            <TStack direction="horizontal" gap="1rem">
              <TFormField :label="t('dynamo.attribute')" style="flex: 1;">
                <TInput :model-value="pkAttr || '—'" disabled />
              </TFormField>
              <TFormField :label="t('dynamo.value')" style="flex: 2;">
                <TInput v-model="pkValue" :placeholder="t('dynamo.enterAttributeValue')" />
              </TFormField>
            </TStack>
          </TStack>

          <TStack v-if="skAttr" direction="vertical" gap="0.5rem">
            <TText weight="semibold" style="font-size: 0.9rem;">{{ t('dynamo.sortKeyOptional') }}</TText>
            <TStack direction="horizontal" gap="0.75rem" align="end">
              <TFormField :label="t('dynamo.attribute')" style="flex: 1.4;">
                <TInput :model-value="skAttr" disabled />
              </TFormField>
              <TFormField :label="t('dynamo.value')" style="flex: 1.2; min-width: 11rem;">
                <TSelect v-model="skOperator" :options="skOperators" />
              </TFormField>
              <TInput
                v-model="skValue"
                :placeholder="t('dynamo.enterAttributeValue')"
                style="flex: 2;"
              />
              <TInput
                v-if="skOperator === 'between'"
                v-model="skValue2"
                :placeholder="t('dynamo.andValue')"
                style="flex: 2;"
              />
              <TCheckbox v-model="sortDescending" :label="t('dynamo.sortDescending')" />
            </TStack>
          </TStack>
        </template>

        <TDivider />

        <TStack direction="vertical" gap="0.5rem">
          <TLink
            href="#"
            style="font-weight: 600; font-size: 0.9rem;"
            @click.prevent="filtersExpanded = !filtersExpanded"
          >
            <TIcon :name="filtersExpanded ? 'chevron-down' : 'chevron-right'" /> {{ t('dynamo.filtersOptional') }}
          </TLink>

          <TStack v-if="filtersExpanded" direction="vertical" gap="0.5rem">
            <TStack
              v-for="(f, i) in filters"
              :key="`f-${i}`"
              direction="horizontal"
              gap="0.5rem"
              align="end"
            >
              <TFormField :label="t('dynamo.attributeName')" style="flex: 1.4;">
                <TInput v-model="f.attr" :placeholder="t('dynamo.enterAttributeName')" />
              </TFormField>
              <TFormField :label="t('dynamo.condition')" style="flex: 1.4;">
                <TSelect v-model="f.op" :options="filterOps" />
              </TFormField>
              <TFormField :label="t('common.type')" style="flex: 0.9;">
                <TSelect v-model="f.type" :options="filterTypeOptions" />
              </TFormField>
              <TFormField :label="t('dynamo.value')" style="flex: 1.7;">
                <TInput
                  v-model="f.value"
                  :disabled="f.op === 'attribute_exists' || f.op === 'attribute_not_exists'"
                  :placeholder="t('dynamo.enterAttributeValue')"
                />
              </TFormField>
              <TButton size="sm" variant="outline" @click="removeFilter(i)">{{ t('dynamo.remove') }}</TButton>
            </TStack>

            <div>
              <TButton size="sm" variant="outline" @click="addFilter">{{ t('dynamo.addFilter') }}</TButton>
            </div>
          </TStack>
        </TStack>
      </TStack>

      <template #footer>
        <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
          <TStack direction="horizontal" gap="0.5rem" align="center">
            <TButton variant="solid" :loading="running" @click="run()">{{ t('dynamo.run') }}</TButton>
            <TButton variant="ghost" @click="reset">{{ t('dynamo.reset') }}</TButton>
          </TStack>
          <TStack direction="horizontal" gap="0.5rem" align="center">
            <TText tone="muted">{{ t('dynamo.limit') }}</TText>
            <TInput v-model.number="limit" type="number" size="sm" style="width: 6rem;" />
          </TStack>
        </TStack>
      </template>
    </TCard>

    <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
      {{ error }}
    </TAlert>

    <TAlert
      v-if="statusVisible && !error"
      :variant="statusInfo.finished ? 'success' : 'warning'"
      dismissible
      @dismiss="statusVisible = false"
    >
      <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
        <span>
          <TText as="strong" weight="semibold">
            {{ statusInfo.finished ? t('dynamo.completed') : t('dynamo.stopped') }}
          </TText>
          · {{ t('dynamo.itemsReturned') }}: <TText as="strong" weight="semibold">{{ statusInfo.returned }}</TText>
          · {{ t('dynamo.itemsScanned') }}: <TText as="strong" weight="semibold">{{ statusInfo.scanned }}</TText>
          · {{ t('dynamo.efficiency') }}: <TText as="strong" weight="semibold">{{ statusInfo.efficiency }}%</TText>
        </span>
        <TButton
          v-if="!statusInfo.finished"
          size="sm"
          variant="outline"
          :loading="running"
          @click="nextPage"
        >
          {{ t('dynamo.retrieveNextPage') }}
        </TButton>
      </TStack>
    </TAlert>

    <TCard variant="outline">
      <template #header>
        <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
          <TStack direction="vertical" gap="0.125rem">
            <TText weight="semibold">
              {{
                indexName
                  ? t('dynamo.resultsIndex', { index: indexName, table: props.table.name })
                  : t('dynamo.resultsTable', { table: props.table.name })
              }}
              – {{ t('dynamo.itemsReturnedCount', { count: items.length }) }}
            </TText>
            <TText tone="muted" size="xs">
              {{
                t('dynamo.startedOn', {
                  mode: mode === 'scan' ? 'Scan' : 'Query',
                  time: startedAt ? startedAt.toLocaleString() : '—',
                })
              }}
            </TText>
          </TStack>
          <TStack direction="horizontal" gap="0.5rem">
            <TButton size="sm" variant="ghost" :loading="running" @click="run()">{{ t('common.refresh') }}</TButton>
            <TButton size="sm" variant="outline" @click="openCreate">{{ t('dynamo.createItem') }}</TButton>
          </TStack>
        </TStack>
      </template>

      <TStack v-if="running && !items.length" direction="horizontal" justify="center" align="center">
        <TSpinner :label="t('dynamo.running')" />
      </TStack>

      <TEmptyState
        v-else-if="!items.length"
        :title="t('dynamo.noItemsTitle')"
        :description="t('dynamo.noItemsDesc')"
      />

      <TTable v-else :columns="columns" :rows="rows" :aria-label="t('dynamo.resultsAriaLabel')">
        <template
          v-for="(name, idx) in keyAttrNames"
          :key="`k-${name}`"
          #[`cell-__attr__${name}`]="{ row }"
        >
          <TLink
            v-if="idx === 0"
            href="#"
            class="mono"
            @click.prevent="openView((row as any).__raw)"
          >
            {{ stringifyShort((row as any)[`__attr__${name}`]) }}
          </TLink>
          <TText v-else family="mono">
            {{ stringifyShort((row as any)[`__attr__${name}`]) }}
          </TText>
        </template>

        <template
          v-for="name in nonKeyAttrsInItems"
          :key="`n-${name}`"
          #[`cell-__attr__${name}`]="{ row }"
        >
          <TText family="mono" size="sm">
            {{ stringifyShort((row as any)[`__attr__${name}`]) }}
          </TText>
        </template>
      </TTable>
    </TCard>

    <DynamoItemEditor
      v-model:open="editorOpen"
      :table-name="props.table.name"
      :mode="editorMode"
      :item="editorItem"
      :original-key="editorOriginalKey"
      @saved="onSaved"
      @request-edit="requestEditFromView"
      @request-clone="requestCloneFromView"
      @request-delete="requestDeleteFromView"
    />

    <TConfirmDialog
      v-model:open="confirmDeleteOpen"
      :title="t('dynamo.deleteItemTitle')"
      :description="t('dynamo.deleteItemDesc', { table: props.table.name })"
      :confirm-label="t('common.delete')"
      :cancel-label="t('common.cancel')"
      tone="danger"
      @confirm="doDelete"
    />
  </TStack>
</template>
