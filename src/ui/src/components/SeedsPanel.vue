<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import {
  TCard, TButton, TBadge, TTable, TEmptyState, TStack, TGrid, TStat,
  TSpinner, TAlert, useToast,
} from '@treeui/vue';
import { api } from '../services/api';
import type { SeedFileEntry } from '../services/api';

const toast = useToast();
const seedsDir = ref<string>('');
const entries = ref<SeedFileEntry[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const busy = ref<Record<string, 'run' | 'clear' | null>>({});
const globalBusy = ref<'run' | 'clear' | null>(null);
let refreshTimer: number | null = null;

const columns = [
  { key: 'tableName', label: 'Table' },
  { key: 'itemCount', label: 'Items in file', align: 'right' as const },
  { key: 'tableExists', label: 'Table' },
  { key: 'actions', label: '', align: 'right' as const },
];

const totals = computed(() => ({
  files: entries.value.length,
  tablesReady: entries.value.filter(e => e.tableExists).length,
  totalItems: entries.value.reduce((s, e) => s + Math.max(0, e.itemCount), 0),
}));

async function load() {
  try {
    const res = await api.listSeeds();
    seedsDir.value = res.seedsDir;
    entries.value = res.entries;
    error.value = null;
  } catch (err: any) {
    error.value = err.message || 'Failed to load seeds';
  } finally {
    loading.value = false;
  }
}

function describeResults(results: Array<{ tableName: string; inserted?: number; deleted?: number; skipped?: boolean; reason?: string }>, verb: 'inserted' | 'deleted') {
  const parts: string[] = [];
  let total = 0;
  for (const r of results) {
    if (r.skipped) {
      parts.push(`${r.tableName} skipped (${r.reason})`);
    } else {
      const n = (verb === 'inserted' ? r.inserted : r.deleted) ?? 0;
      total += n;
      parts.push(`${r.tableName}: ${n}`);
    }
  }
  return { summary: `${total} item(s) ${verb}`, detail: parts.join(' · ') };
}

async function runOne(tableName: string) {
  busy.value[tableName] = 'run';
  try {
    const res = await api.runSeed(tableName);
    const { summary, detail } = describeResults(res.results, 'inserted');
    toast.add({ title: `Seeded ${tableName}`, description: `${summary} — ${detail}`, variant: 'success' });
    await load();
  } catch (err: any) {
    toast.add({ title: `Seed failed`, description: err.message, variant: 'danger' });
  } finally {
    busy.value[tableName] = null;
  }
}

async function clearOne(tableName: string) {
  busy.value[tableName] = 'clear';
  try {
    const res = await api.clearSeed(tableName);
    const { summary, detail } = describeResults(res.results, 'deleted');
    toast.add({ title: `Cleared ${tableName}`, description: `${summary} — ${detail}`, variant: 'info' });
    await load();
  } catch (err: any) {
    toast.add({ title: `Clear failed`, description: err.message, variant: 'danger' });
  } finally {
    busy.value[tableName] = null;
  }
}

async function runAll() {
  globalBusy.value = 'run';
  try {
    const res = await api.runSeed();
    const { summary, detail } = describeResults(res.results, 'inserted');
    toast.add({ title: 'Seeded all tables', description: `${summary} — ${detail}`, variant: 'success' });
    await load();
  } catch (err: any) {
    toast.add({ title: 'Seed all failed', description: err.message, variant: 'danger' });
  } finally {
    globalBusy.value = null;
  }
}

async function clearAll() {
  if (!confirm('Delete every item from all tables that have a seed file?')) return;
  globalBusy.value = 'clear';
  try {
    const res = await api.clearSeed();
    const { summary, detail } = describeResults(res.results, 'deleted');
    toast.add({ title: 'Cleared all seeded tables', description: `${summary} — ${detail}`, variant: 'info' });
    await load();
  } catch (err: any) {
    toast.add({ title: 'Clear all failed', description: err.message, variant: 'danger' });
  } finally {
    globalBusy.value = null;
  }
}

onMounted(() => {
  load();
  refreshTimer = window.setInterval(load, 15000);
});

onBeforeUnmount(() => {
  if (refreshTimer) window.clearInterval(refreshTimer);
});
</script>

<template>
  <TStack direction="vertical" gap="1.25rem">
    <TGrid :columns="3" gap="1rem">
      <TStat label="Seed files" :value="totals.files" tone="info" :loading="loading" />
      <TStat label="Tables ready" :value="totals.tablesReady" tone="success" :loading="loading" />
      <TStat label="Items across files" :value="totals.totalItems" tone="warning" :loading="loading" />
    </TGrid>

    <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
      {{ error }}
    </TAlert>

    <TCard variant="outline">
      <template #header>
        <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
          <TStack direction="vertical" gap="0.125rem">
            <strong>DynamoDB seeds</strong>
            <span class="muted mono" style="font-size: 0.75rem;">{{ seedsDir || '—' }}</span>
          </TStack>
          <TStack direction="horizontal" gap="0.5rem">
            <TButton
              size="sm"
              variant="soft"
              :disabled="loading || !entries.length || globalBusy !== null"
              :loading="globalBusy === 'run'"
              @click="runAll"
            >
              Re-apply all
            </TButton>
            <TButton
              size="sm"
              variant="ghost"
              tone="danger"
              :disabled="loading || !entries.length || globalBusy !== null"
              :loading="globalBusy === 'clear'"
              @click="clearAll"
            >
              Clear all
            </TButton>
          </TStack>
        </TStack>
      </template>

      <div v-if="loading" style="display: flex; justify-content: center; padding: 2rem;">
        <TSpinner label="Loading seeds..." />
      </div>

      <TEmptyState
        v-else-if="!entries.length"
        title="No seed files found"
        :description="`Drop {tableName}.json files into ${seedsDir} to seed DynamoDB tables automatically.`"
      />

      <TTable v-else :columns="columns" :rows="entries">
        <template #cell-tableName="{ row }">
          <TStack direction="vertical" gap="0.125rem">
            <strong>{{ row.tableName }}</strong>
            <span class="muted mono" style="font-size: 0.75rem;">{{ String(row.file) }}</span>
          </TStack>
        </template>

        <template #cell-itemCount="{ row }">
          <TBadge
            v-if="Number(row.itemCount) >= 0"
            :tone="Number(row.itemCount) > 0 ? 'info' : 'neutral'"
            variant="soft"
          >
            {{ row.itemCount }}
          </TBadge>
          <TBadge v-else tone="danger" variant="soft">parse error</TBadge>
        </template>

        <template #cell-tableExists="{ row }">
          <TBadge :tone="row.tableExists ? 'success' : 'warning'" variant="soft">
            {{ row.tableExists ? 'exists' : 'not created' }}
          </TBadge>
        </template>

        <template #cell-actions="{ row }">
          <TStack direction="horizontal" gap="0.375rem" justify="flex-end">
            <TButton
              size="sm"
              variant="soft"
              :disabled="!row.tableExists || Number(row.itemCount) <= 0 || busy[String(row.tableName)] !== undefined && busy[String(row.tableName)] !== null"
              :loading="busy[String(row.tableName)] === 'run'"
              @click="runOne(String(row.tableName))"
            >
              Apply
            </TButton>
            <TButton
              size="sm"
              variant="ghost"
              tone="danger"
              :disabled="!row.tableExists || busy[String(row.tableName)] !== undefined && busy[String(row.tableName)] !== null"
              :loading="busy[String(row.tableName)] === 'clear'"
              @click="clearOne(String(row.tableName))"
            >
              Clear
            </TButton>
          </TStack>
        </template>
      </TTable>
    </TCard>
  </TStack>
</template>
