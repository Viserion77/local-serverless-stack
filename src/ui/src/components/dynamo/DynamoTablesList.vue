<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { RouterLink } from 'vue-router';
import {
  TCard, TButton, TBadge, TStack, TGrid, TStat, TEmptyState,
  TSpinner, TAlert, TTag, TTable, TInput, TText,
} from '@treeui/vue';
import { api } from '../../services/api';
import type { DynamoTableSummary, SeedFileEntry } from '../../services/api';
import { useI18n } from '../../i18n';

const { t } = useI18n();

const emit = defineEmits<{ (e: 'open', name: string): void }>();

// TTable's `rows` prop is Record<string, unknown>[]; the index signature keeps
// the concrete row type usable there without casting at every call site.
interface TableRow {
  [key: string]: unknown;
  name: string;
  status?: string;
  itemCount: number;
  keyDescriptor: string;
  billingMode?: string;
  ttlOn: boolean;
  streamOn: boolean;
  hasGsi: boolean;
  hasLsi: boolean;
  service: string;
  seedItemCount: number | null;
  exists: boolean;
}

const tables = ref<DynamoTableSummary[]>([]);
const seeds = ref<SeedFileEntry[]>([]);
const ownersByTable = ref<Record<string, string>>({});
const loading = ref(true);
const error = ref<string | null>(null);
const search = ref('');
let timer: number | null = null;

// Computed, not a module-level const: the header labels have to be re-read
// through t() so a language switch relabels the table without a reload.
const columns = computed(() => [
  { key: 'name', label: t('dynamo.colTable') },
  { key: 'service', label: t('common.service') },
  { key: 'status', label: t('common.status') },
  { key: 'itemCount', label: t('dynamo.items'), align: 'right' as const },
  { key: 'seed', label: t('dynamo.seed') },
  { key: 'features', label: t('dynamo.features') },
  { key: 'actions', label: '', align: 'right' as const },
]);

const rows = computed<TableRow[]>(() => {
  const merged: TableRow[] = tables.value.map(t => {
    const pk = t.keySchema.find(k => k.KeyType === 'HASH')?.AttributeName;
    const sk = t.keySchema.find(k => k.KeyType === 'RANGE')?.AttributeName;
    const keyDescriptor = sk ? `PK: ${pk} · SK: ${sk}` : `PK: ${pk ?? '—'}`;
    const seedEntry = seeds.value.find(s => s.tableName === t.name);
    return {
      name: t.name,
      status: t.status,
      itemCount: t.itemCount || 0,
      keyDescriptor,
      billingMode: t.billingMode,
      ttlOn: t.ttl.enabled,
      streamOn: t.streamEnabled,
      hasGsi: t.hasGsi,
      hasLsi: t.hasLsi,
      service: ownersByTable.value[t.name] || '',
      seedItemCount: seedEntry ? seedEntry.itemCount : null,
      exists: true,
    };
  });

  // Add ghost rows for seeds that don't have a live table yet
  for (const s of seeds.value) {
    if (!s.tableExists && !merged.some(m => m.name === s.tableName)) {
      merged.push({
        name: s.tableName,
        status: 'PENDING',
        itemCount: 0,
        keyDescriptor: '—',
        ttlOn: false,
        streamOn: false,
        hasGsi: false,
        hasLsi: false,
        service: ownersByTable.value[s.tableName] || '',
        seedItemCount: s.itemCount,
        exists: false,
      });
    }
  }

  return merged.sort((a, b) => a.name.localeCompare(b.name));
});

const filteredRows = computed<TableRow[]>(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return rows.value;
  return rows.value.filter(r =>
    r.name.toLowerCase().includes(q) ||
    (r.service || '').toLowerCase().includes(q),
  );
});

const totals = computed(() => ({
  tables: tables.value.length,
  items: tables.value.reduce((s, t) => s + (t.itemCount || 0), 0),
  warnings: tables.value.reduce((s, t) => s + (t.warnings?.length || 0), 0),
  seedsPending: seeds.value.filter(s => !s.tableExists).length,
}));

async function load() {
  try {
    const [tablesRes, seedsRes, owners] = await Promise.all([
      api.listDynamoTables(),
      api.listSeeds().catch(() => ({ seedsDir: '', entries: [] })),
      api.listResourceOwners().catch(() => ({ tables: [], queues: [], topics: [], buckets: [] })),
    ]);
    tables.value = tablesRes.tables;
    seeds.value = seedsRes.entries;
    const map: Record<string, string> = {};
    for (const o of owners.tables) map[o.name] = o.service;
    ownersByTable.value = map;
    error.value = null;
  } catch (err: any) {
    error.value = err.message || t('dynamo.loadTablesFailed');
  } finally {
    loading.value = false;
  }
}

function openRow(row: TableRow) {
  if (!row.exists) return;
  emit('open', row.name);
}

// Called from the template so t() runs on every render — the badge follows a
// language switch and picks the singular/plural form for the count.
function seededItemsLabel(count: number): string {
  return count === 1
    ? t('dynamo.seededItemOne', { count })
    : t('dynamo.seededItemOther', { count });
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
    <TGrid :columns="4" gap="1rem">
      <TStat :label="t('dynamo.statTables')" :value="totals.tables" tone="info" :loading="loading" />
      <TStat :label="t('dynamo.statTotalItems')" :value="totals.items" tone="success" :loading="loading" />
      <TStat
        :label="t('dynamo.statSeedsPending')"
        :value="totals.seedsPending"
        :tone="totals.seedsPending > 0 ? 'warning' : 'neutral'"
        :loading="loading"
      />
      <TStat
        :label="t('dynamo.statWarnings')"
        :value="totals.warnings"
        :tone="totals.warnings > 0 ? 'warning' : 'neutral'"
        :loading="loading"
      />
    </TGrid>

    <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
      {{ error }}
    </TAlert>

    <TCard variant="outline">
      <template #header>
        <TStack direction="horizontal" justify="space-between" align="center" gap="1rem">
          <TText weight="semibold">{{ t('dynamo.tablesTitle') }}</TText>
          <TStack direction="horizontal" align="center" gap="1rem">
            <TInput
              v-model="search"
              :placeholder="t('dynamo.filterTablesPlaceholder')"
              style="min-width: 16rem;"
            />
            <TText tone="muted" size="xs">
              {{ t('dynamo.seedOnlyHint') }}
            </TText>
          </TStack>
        </TStack>
      </template>

      <TStack v-if="loading" direction="horizontal" justify="center" align="center">
        <TSpinner :label="t('dynamo.loadingTables')" />
      </TStack>

      <TEmptyState
        v-else-if="!rows.length"
        :title="t('dynamo.emptyTablesTitle')"
        :description="t('dynamo.emptyTablesDesc')"
      />

      <TEmptyState
        v-else-if="!filteredRows.length"
        :title="t('dynamo.noMatchTitle')"
        :description="t('dynamo.noMatchDesc', { query: search })"
      />

      <TTable
        v-else
        :columns="columns"
        :rows="filteredRows"
        row-key="name"
        :row-state="(row: any) => row.exists ? 'default' : 'muted'"
        :aria-label="t('dynamo.tablesTitle')"
      >
        <template #cell-name="{ row }">
          <TStack direction="vertical" gap="0.125rem">
            <TText
              v-if="row.exists"
              weight="semibold"
              style="cursor: pointer; text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 3px;"
              @click="openRow(row as any)"
            >
              {{ row.name }}
            </TText>
            <TStack v-else direction="horizontal" gap="0.375rem" align="center">
              <TText weight="semibold">{{ row.name }}</TText>
              <TTag size="sm" variant="soft">{{ t('dynamo.seedOnly') }}</TTag>
            </TStack>
            <TText tone="muted" family="mono" size="xs">
              {{ row.keyDescriptor }}
            </TText>
          </TStack>
        </template>

        <template #cell-service="{ row }">
          <RouterLink
            v-if="row.service"
            :to="`/services/${encodeURIComponent(String(row.service))}`"
            style="text-decoration: none;"
          >
            <TTag size="sm" variant="soft" clickable>{{ row.service }}</TTag>
          </RouterLink>
          <TText v-else tone="muted" size="xs">—</TText>
        </template>

        <template #cell-status="{ row }">
          <TBadge
            v-if="row.exists"
            :tone="row.status === 'ACTIVE' ? 'success' : 'warning'"
            variant="soft"
          >
            {{ row.status || 'UNKNOWN' }}
          </TBadge>
          <TBadge v-else tone="warning" variant="outline">{{ t('dynamo.notCreated') }}</TBadge>
        </template>

        <template #cell-itemCount="{ row }">
          {{ row.exists ? row.itemCount : '—' }}
        </template>

        <template #cell-seed="{ row }">
          <TBadge
            v-if="row.seedItemCount !== null"
            :tone="row.exists ? 'info' : 'warning'"
            variant="soft"
          >
            {{ seededItemsLabel(Number(row.seedItemCount)) }}
          </TBadge>
          <TText v-else tone="muted" size="xs">{{ t('dynamo.noSeed') }}</TText>
        </template>

        <template #cell-features="{ row }">
          <TStack direction="horizontal" gap="0.25rem" wrap>
            <TTag v-if="row.billingMode" size="sm" variant="soft">
              {{ row.billingMode }}
            </TTag>
            <TTag v-if="row.ttlOn" size="sm" variant="solid">TTL</TTag>
            <TTag v-if="row.streamOn" size="sm" variant="solid">Streams</TTag>
            <TTag v-if="row.hasGsi" size="sm" variant="soft">GSI</TTag>
            <TTag v-if="row.hasLsi" size="sm" variant="soft">LSI</TTag>
          </TStack>
        </template>

        <template #cell-actions="{ row }">
          <TButton
            v-if="row.exists"
            size="sm"
            variant="soft"
            @click="openRow(row as any)"
          >
            {{ t('dynamo.explore') }}
          </TButton>
          <TText v-else tone="muted" size="xs">
            {{ t('dynamo.registerToProvision') }}
          </TText>
        </template>
      </TTable>
    </TCard>
  </TStack>
</template>
