<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import {
  TCard, TButton, TBadge, TTable, TEmptyState, TStack, TGrid, TStat,
  TTag, TSpinner, TAlert,
} from '@treeui/vue';
import type { TreeBadgeTone } from '@treeui/vue';
import { api } from '../../services/api';
import type { LambdaSummary } from '../../services/api';

const router = useRouter();
const lambdas = ref<LambdaSummary[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
let refreshTimer: number | null = null;

const columns = [
  { key: 'name', label: 'Function' },
  { key: 'service', label: 'Service' },
  { key: 'runtime', label: 'Runtime' },
  { key: 'handler', label: 'Handler' },
  { key: 'triggers', label: 'Triggers' },
  { key: 'status', label: 'Status' },
  { key: 'invocations', label: 'Invocations', align: 'right' as const },
  { key: 'last', label: 'Last' },
];

const rows = computed(() => lambdas.value.map(l => ({ ...l })));

const totals = computed(() => ({
  total: lambdas.value.length,
  online: lambdas.value.filter(l => l.status === 'online').length,
  invocations: lambdas.value.reduce((s, l) => s + l.invocations, 0),
  errors: lambdas.value.reduce((s, l) => s + l.errors, 0),
}));

async function loadLambdas() {
  try {
    lambdas.value = await api.listLambdas();
    error.value = null;
  } catch (err: any) {
    error.value = err.message || 'Failed to load lambdas';
  } finally {
    loading.value = false;
  }
}

function openDetail(name: string) {
  router.push(`/lambdas/${encodeURIComponent(name)}`);
}

function statusTone(status: string): TreeBadgeTone {
  switch (status) {
    case 'online': return 'success';
    case 'starting': return 'info';
    case 'stopped': return 'neutral';
    default: return 'danger';
  }
}

function formatDate(ts?: number): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

onMounted(() => {
  loadLambdas();
  refreshTimer = window.setInterval(loadLambdas, 10000);
});

onBeforeUnmount(() => {
  if (refreshTimer) window.clearInterval(refreshTimer);
});
</script>

<template>
  <TStack direction="vertical" gap="1.25rem">
    <TGrid :columns="4" gap="1rem">
      <TStat
        label="Functions"
        :value="totals.total"
        tone="info"
        :loading="loading"
      />
      <TStat
        label="Online"
        :value="totals.online"
        tone="success"
        :loading="loading"
      />
      <TStat
        label="Invocations (session)"
        :value="totals.invocations"
        tone="info"
        :loading="loading"
      />
      <TStat
        label="Errors"
        :value="totals.errors"
        :tone="totals.errors > 0 ? 'warning' : 'neutral'"
        :loading="loading"
      />
    </TGrid>

    <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
      {{ error }}
    </TAlert>

    <TCard variant="outline">
      <template #header>
        <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
          <strong>Lambda functions</strong>
          <span class="muted">Live · refreshes every 10s</span>
        </TStack>
      </template>

      <div v-if="loading" style="display: flex; justify-content: center; padding: 2rem;">
        <TSpinner label="Loading lambdas..." />
      </div>

      <TEmptyState
        v-else-if="!lambdas.length"
        title="No functions registered"
        description="Register a microservice that defines Lambda functions to see them here."
      />

      <TTable v-else :columns="columns" :rows="rows">
        <template #cell-name="{ row }">
          <TStack direction="vertical" gap="0.125rem">
            <a
              href="#"
              style="text-decoration: none; font-weight: 600;"
              @click.prevent="openDetail(String(row.name))"
            >
              {{ row.name }}
            </a>
            <span class="muted mono" style="font-size: 0.75rem;">
              {{ row.fullName }}
            </span>
          </TStack>
        </template>

        <template #cell-service="{ row }">
          <RouterLink
            :to="`/services/${encodeURIComponent(String(row.service))}`"
            style="text-decoration: none;"
          >
            <TTag size="sm" variant="soft" clickable>{{ row.service }}</TTag>
          </RouterLink>
        </template>

        <template #cell-runtime="{ row }">
          {{ row.runtime }}
        </template>

        <template #cell-handler="{ row }">
          <span class="mono" style="font-size: 0.78rem;">{{ row.handler }}</span>
        </template>

        <template #cell-triggers="{ row }">
          <TStack direction="horizontal" gap="0.25rem" wrap>
            <template v-if="(row.triggers as string[]).length">
              <TTag
                v-for="t in (row.triggers as string[])"
                :key="t"
                size="sm"
                variant="soft"
              >
                {{ t }}
              </TTag>
            </template>
            <span v-else class="muted">—</span>
          </TStack>
        </template>

        <template #cell-status="{ row }">
          <TBadge :tone="statusTone(String(row.status))" variant="soft">
            {{ row.status }}
          </TBadge>
        </template>

        <template #cell-invocations="{ row }">
          <TStack direction="horizontal" gap="0.375rem" justify="flex-end">
            <TBadge
              :tone="Number(row.invocations) > 0 ? 'info' : 'neutral'"
              variant="soft"
            >
              {{ row.invocations }}
            </TBadge>
            <TBadge v-if="Number(row.errors) > 0" tone="danger" variant="soft">
              {{ row.errors }} err
            </TBadge>
          </TStack>
        </template>

        <template #cell-last="{ row }">
          <TStack direction="vertical" gap="0.125rem">
            <span style="font-size: 0.8rem;">{{ formatDate(row.lastInvokedAt as number | undefined) }}</span>
            <span v-if="row.lastDurationMs !== undefined" class="muted mono" style="font-size: 0.75rem;">
              {{ row.lastDurationMs }}ms
            </span>
          </TStack>
        </template>
      </TTable>
    </TCard>
  </TStack>
</template>
