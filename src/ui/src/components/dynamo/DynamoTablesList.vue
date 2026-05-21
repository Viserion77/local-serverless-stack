<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { RouterLink } from 'vue-router';
import {
  TCard, TButton, TBadge, TStack, TGrid, TStat, TEmptyState,
  TSpinner, TAlert, TTag, TTable, TInput,
} from '@treeui/vue';
import { api } from '../../services/api';
import type { DynamoTableSummary, SeedFileEntry } from '../../services/api';

const emit = defineEmits<{ (e: 'open', name: string): void }>();

interface TableRow {
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

const columns = [
  { key: 'name', label: 'Table' },
  { key: 'service', label: 'Service' },
  { key: 'status', label: 'Status' },
  { key: 'itemCount', label: 'Items', align: 'right' as const },
  { key: 'seed', label: 'Seed' },
  { key: 'features', label: 'Features' },
  { key: 'actions', label: '', align: 'right' as const },
];

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
    error.value = err.message || 'Failed to load DynamoDB tables';
  } finally {
    loading.value = false;
  }
}

function openRow(row: TableRow) {
  if (!row.exists) return;
  emit('open', row.name);
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
      <TStat label="Tables" :value="totals.tables" tone="info" :loading="loading" />
      <TStat label="Total items" :value="totals.items" tone="success" :loading="loading" />
      <TStat
        label="Seeds pending"
        :value="totals.seedsPending"
        :tone="totals.seedsPending > 0 ? 'warning' : 'neutral'"
        :loading="loading"
      />
      <TStat
        label="Warnings"
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
          <strong>DynamoDB tables</strong>
          <TStack direction="horizontal" align="center" gap="1rem">
            <TInput
              v-model="search"
              placeholder="Filter tables..."
              style="min-width: 16rem;"
            />
            <span class="muted" style="font-size: 0.75rem;">
              Rows with reduced opacity exist only as a seed file
            </span>
          </TStack>
        </TStack>
      </template>

      <div v-if="loading" style="display: flex; justify-content: center; padding: 2rem;">
        <TSpinner label="Loading tables..." />
      </div>

      <TEmptyState
        v-else-if="!rows.length"
        title="No DynamoDB tables"
        description="Register a microservice with DynamoDB resources or drop a seed file into the seeds directory."
      />

      <TEmptyState
        v-else-if="!filteredRows.length"
        title="No matching tables"
        :description="`No tables match &quot;${search}&quot;.`"
      />

      <TTable
        v-else
        :columns="columns"
        :rows="filteredRows"
        :row-class="(row: any) => row.exists ? '' : 'dim-row'"
      >
        <template #cell-name="{ row }">
          <TStack direction="vertical" gap="0.125rem">
            <strong
              v-if="row.exists"
              style="cursor: pointer; text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 3px;"
              @click="openRow(row as any)"
            >
              {{ row.name }}
            </strong>
            <strong v-else>{{ row.name }}</strong>
            <span class="muted mono" style="font-size: 0.75rem;">
              {{ row.keyDescriptor }}
            </span>
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
          <span v-else class="muted" style="font-size: 0.75rem;">—</span>
        </template>

        <template #cell-status="{ row }">
          <TBadge
            v-if="row.exists"
            :tone="row.status === 'ACTIVE' ? 'success' : 'warning'"
            variant="soft"
          >
            {{ row.status || 'UNKNOWN' }}
          </TBadge>
          <TBadge v-else tone="warning" variant="outline">Not created</TBadge>
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
            {{ row.seedItemCount }} seeded item{{ row.seedItemCount === 1 ? '' : 's' }}
          </TBadge>
          <span v-else class="muted" style="font-size: 0.75rem;">no seed</span>
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
            Explore
          </TButton>
          <span v-else class="muted" style="font-size: 0.75rem;">
            Register service to provision
          </span>
        </template>
      </TTable>
    </TCard>
  </TStack>
</template>
