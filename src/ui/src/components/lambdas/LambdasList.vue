<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { RouterLink } from 'vue-router';
import {
  TCard, TBadge, TTable, TEmptyState, TStack, TGrid, TStat,
  TTag, TSpinner, TAlert, TText, TLink,
} from '@treeui/vue';
import type { TBadgeTone } from '@treeui/vue';
import { api } from '../../services/api';
import type { LambdaSummary } from '../../services/api';
import { useI18n } from '../../i18n';

const { t } = useI18n();

const lambdas = ref<LambdaSummary[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
let refreshTimer: number | null = null;

// Computed rather than a module const: the headers have to be re-translated
// when the user switches language, without a reload.
const columns = computed(() => [
  { key: 'name', label: t('lambdas.function') },
  { key: 'service', label: t('common.service') },
  { key: 'runtime', label: t('lambdas.runtime') },
  { key: 'handler', label: t('lambdas.handler') },
  { key: 'triggers', label: t('lambdas.triggers') },
  { key: 'status', label: t('common.status') },
  { key: 'invocations', label: t('lambdas.invocations'), align: 'right' as const },
  { key: 'last', label: t('lambdas.last') },
]);

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
    error.value = err.message || t('lambdas.loadFailed');
  } finally {
    loading.value = false;
  }
}

function statusTone(status: string): TBadgeTone {
  switch (status) {
    case 'online': return 'success';
    case 'starting': return 'info';
    case 'stopped': return 'neutral';
    default: return 'danger';
  }
}

// The API returns the state as a lowercase enum; the badge shows it in the
// user's language, keeping the same lowercase register as the other screens.
function statusLabel(status: string): string {
  switch (status) {
    case 'online': return t('common.online');
    case 'starting': return t('lambdas.statusStarting');
    case 'stopped': return t('common.stopped');
    case 'error': return t('lambdas.statusError');
    default: return status;
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
        :label="t('lambdas.statFunctions')"
        :value="totals.total"
        tone="info"
        :loading="loading"
      />
      <TStat
        :label="t('lambdas.statOnline')"
        :value="totals.online"
        tone="success"
        :loading="loading"
      />
      <TStat
        :label="t('lambdas.statInvocations')"
        :value="totals.invocations"
        tone="info"
        :loading="loading"
      />
      <TStat
        :label="t('lambdas.statErrors')"
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
          <TText weight="semibold">{{ t('lambdas.listTitle') }}</TText>
          <TText tone="muted">{{ t('lambdas.listLive') }}</TText>
        </TStack>
      </template>

      <TStack v-if="loading" direction="horizontal" justify="center" align="center">
        <TSpinner :label="t('lambdas.loadingList')" />
      </TStack>

      <TEmptyState
        v-else-if="!lambdas.length"
        :title="t('lambdas.emptyTitle')"
        :description="t('lambdas.emptyDescription')"
      />

      <TTable v-else :columns="columns" :rows="rows" :aria-label="t('lambdas.listTitle')">
        <template #cell-name="{ row }">
          <TStack direction="vertical" gap="0.125rem">
            <TLink
              :to="`/lambdas/${encodeURIComponent(String(row.name))}`"
              style="font-weight: 600;"
            >
              {{ row.name }}
            </TLink>
            <TText tone="muted" family="mono" size="xs">
              {{ row.fullName }}
            </TText>
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
          <TText family="mono" style="font-size: 0.78rem;">{{ row.handler }}</TText>
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
            <TText v-else tone="muted">—</TText>
          </TStack>
        </template>

        <template #cell-status="{ row }">
          <TBadge :tone="statusTone(String(row.status))" variant="soft">
            {{ statusLabel(String(row.status)) }}
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
              {{ t('lambdas.errShort', { count: Number(row.errors) }) }}
            </TBadge>
          </TStack>
        </template>

        <template #cell-last="{ row }">
          <TStack direction="vertical" gap="0.125rem">
            <TText size="sm">{{ formatDate(row.lastInvokedAt as number | undefined) }}</TText>
            <TText v-if="row.lastDurationMs !== undefined" tone="muted" family="mono" size="xs">
              {{ row.lastDurationMs }}ms
            </TText>
          </TStack>
        </template>
      </TTable>
    </TCard>
  </TStack>
</template>
