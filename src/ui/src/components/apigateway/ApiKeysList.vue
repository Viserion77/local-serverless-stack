<script setup lang="ts">
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue';
import {
  TCard, TButton, TStack, TStackItem, TGrid, TStat, TEmptyState,
  TSpinner, TAlert, TTag, TTable, TInput, TBadge, TText, TIcon, useToast,
} from '@treeui/vue';
import { api } from '../../services/api';
import type { ApiKeySummary, UsagePlanSummary } from '../../services/api';
import { useI18n } from '../../i18n';

const toast = useToast();
const { t } = useI18n();

const keys = ref<ApiKeySummary[]>([]);
const plans = ref<UsagePlanSummary[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const search = ref('');
let timer: number | null = null;

// Revealed values, by key id. The list endpoint never carries a value: one
// only lands here after an explicit Reveal, and Hide drops it again, so the
// masked state is the default for every row and survives the 15s refresh.
const revealed = reactive(new Map<string, string>());
const revealing = ref<string | null>(null);

// Computed rather than module consts: the labels go through t() on every
// render so a language switch relabels the tables without a reload.
const keyColumns = computed(() => [
  { key: 'id', label: t('apiKeys.columnId') },
  { key: 'name', label: t('apiKeys.columnName') },
  { key: 'status', label: t('apiKeys.columnStatus') },
  { key: 'value', label: t('apiKeys.columnValue') },
  { key: 'plans', label: t('apiKeys.columnPlans') },
]);

const planColumns = computed(() => [
  { key: 'id', label: t('apiKeys.columnId') },
  { key: 'name', label: t('apiKeys.columnName') },
  { key: 'stages', label: t('apiKeys.columnStages') },
  { key: 'throttle', label: t('apiKeys.columnThrottle') },
  { key: 'quota', label: t('apiKeys.columnQuota') },
  { key: 'keys', label: t('apiKeys.columnKeys'), align: 'right' as const },
]);

const keyRows = computed(() =>
  keys.value.map(k => ({
    ...k,
    displayName: k.name || '—',
  })),
);

const filteredKeyRows = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return keyRows.value;
  return keyRows.value.filter(r =>
    r.id.toLowerCase().includes(q) ||
    (r.name || '').toLowerCase().includes(q) ||
    (r.customerId || '').toLowerCase().includes(q),
  );
});

const planRows = computed(() =>
  plans.value.map(p => ({
    ...p,
    displayName: p.name || '—',
    throttleText: p.throttle
      ? t('apiKeys.throttleValue', {
          rate: String(p.throttle.rateLimit ?? '—'),
          burst: String(p.throttle.burstLimit ?? '—'),
        })
      : t('apiKeys.unlimited'),
    quotaText: p.quota?.limit !== undefined
      ? t('apiKeys.quotaValue', { limit: String(p.quota.limit), period: p.quota.period ?? '—' })
      : t('apiKeys.unlimited'),
  })),
);

const totals = computed(() => ({
  keys: keys.value.length,
  enabled: keys.value.filter(k => k.enabled).length,
  plans: plans.value.length,
}));

async function load() {
  try {
    const [keysRes, plansRes] = await Promise.all([api.listApiKeys(), api.listUsagePlans()]);
    keys.value = keysRes.keys;
    plans.value = plansRes.plans;
    // A deleted key's revealed value must not linger in memory.
    const live = new Set(keysRes.keys.map(k => k.id));
    for (const id of [...revealed.keys()]) if (!live.has(id)) revealed.delete(id);
    error.value = null;
  } catch (err: any) {
    error.value = err.message || t('apiKeys.loadFailed');
  } finally {
    loading.value = false;
  }
}

function keyName(row: Record<string, unknown>): string {
  return String(row.name || row.id);
}

async function reveal(id: string) {
  revealing.value = id;
  try {
    const res = await api.getApiKeyValue(id);
    revealed.set(id, res.value);
  } catch (err: any) {
    toast.add({ title: t('apiKeys.revealFailed'), description: err.message, variant: 'danger' });
  } finally {
    revealing.value = null;
  }
}

function hide(id: string) {
  revealed.delete(id);
}

async function copyValue(id: string) {
  const value = revealed.get(id);
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    toast.add({ title: t('apiKeys.copiedToClipboard'), variant: 'success' });
  } catch {
    toast.add({ title: t('apiKeys.copyFailed'), variant: 'danger' });
  }
}

onMounted(() => {
  load();
  timer = window.setInterval(load, 15000);
});

onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer);
  revealed.clear();
});
</script>

<template>
  <TStack direction="vertical" gap="1.25rem">
    <TGrid :columns="3" gap="1rem">
      <TStat :label="t('apiKeys.statKeys')" :value="totals.keys" tone="info" :loading="loading" />
      <TStat :label="t('apiKeys.statEnabled')" :value="totals.enabled" tone="success" :loading="loading" />
      <TStat :label="t('apiKeys.statPlans')" :value="totals.plans" tone="info" :loading="loading" />
    </TGrid>

    <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
      {{ error }}
    </TAlert>

    <TCard variant="outline">
      <template #header>
        <TStack direction="horizontal" justify="space-between" align="center" gap="1rem">
          <!-- API Gateway is the AWS brand name; the mark is the same identity
               in visual form. -->
          <TStack direction="horizontal" gap="0.5rem" align="center">
            <TIcon name="aws-api-gateway" />
            <TText weight="semibold">{{ t('apiKeys.keysHeading') }}</TText>
          </TStack>
          <TStack direction="horizontal" align="center" gap="1rem">
            <!-- The floor is the flex item's, not the field's: TInput's `width`
                 is a cap (TFieldWidth), never a minimum. -->
            <TStackItem min-width="16rem">
              <TInput
                v-model="search"
                :placeholder="t('apiKeys.filterPlaceholder')"
                :aria-label="t('apiKeys.filterLabel')"
              />
            </TStackItem>
            <TText tone="muted" size="xs">{{ t('apiKeys.autoRefresh') }}</TText>
          </TStack>
        </TStack>
      </template>

      <TStack v-if="loading" direction="horizontal" justify="center" align="center">
        <TSpinner :label="t('apiKeys.loadingKeys')" />
      </TStack>

      <TEmptyState
        v-else-if="!keyRows.length"
        :title="t('apiKeys.keysEmptyTitle')"
        :description="t('apiKeys.keysEmptyBody')"
      >
        <template #icon>
          <TIcon name="aws-api-gateway" />
        </template>
      </TEmptyState>

      <!-- Filter state, not a service state — stays a TreeUI functional icon. -->
      <TEmptyState
        v-else-if="!filteredKeyRows.length"
        :title="t('apiKeys.noMatchTitle')"
        :description="t('apiKeys.noMatchBody', { query: search })"
      >
        <template #icon>
          <TIcon name="search-x" />
        </template>
      </TEmptyState>

      <TTable
        v-else
        :columns="keyColumns"
        :rows="filteredKeyRows"
        row-key="id"
        :aria-label="t('apiKeys.keysTableLabel')"
      >
        <template #cell-id="{ row }">
          <TText family="mono" size="xs">{{ row.id }}</TText>
        </template>

        <template #cell-name="{ row }">
          <TStack direction="vertical" gap="0.15rem">
            <TText weight="semibold">{{ row.displayName }}</TText>
            <TText v-if="row.customerId" tone="muted" size="xs">{{ t('apiKeys.customer', { id: String(row.customerId) }) }}</TText>
          </TStack>
        </template>

        <template #cell-status="{ row }">
          <TBadge :tone="row.enabled ? 'success' : 'neutral'" variant="soft">
            {{ row.enabled ? t('apiKeys.enabled') : t('apiKeys.disabled') }}
          </TBadge>
        </template>

        <template #cell-value="{ row }">
          <!-- Masked by default: the value is fetched from its own endpoint
               only when asked for, like the Secrets reveal. `loading-label`
               keeps the busy button's accessible name translated (rule 6). -->
          <TStack v-if="revealed.has(String(row.id))" direction="horizontal" align="center" gap="0.5rem" wrap>
            <TText family="mono" size="xs" wrap="anywhere">{{ revealed.get(String(row.id)) }}</TText>
            <TButton
              size="sm"
              variant="ghost"
              :aria-label="t('apiKeys.copyLabel', { name: keyName(row) })"
              @click="copyValue(String(row.id))"
            >
              {{ t('common.copy') }}
            </TButton>
            <TButton
              size="sm"
              variant="ghost"
              :aria-label="t('apiKeys.hideLabel', { name: keyName(row) })"
              @click="hide(String(row.id))"
            >
              {{ t('apiKeys.hide') }}
            </TButton>
          </TStack>
          <TStack v-else direction="horizontal" align="center" gap="0.5rem">
            <TText tone="muted" size="xs">{{ t('apiKeys.valueHidden') }}</TText>
            <TButton
              size="sm"
              variant="soft"
              :loading="revealing === String(row.id)"
              :loading-label="t('common.loading')"
              :aria-label="t('apiKeys.revealLabel', { name: keyName(row) })"
              @click="reveal(String(row.id))"
            >
              {{ t('apiKeys.reveal') }}
            </TButton>
          </TStack>
        </template>

        <template #cell-plans="{ row }">
          <TStack v-if="(row.usagePlans as ApiKeySummary['usagePlans']).length" direction="horizontal" gap="0.35rem" wrap>
            <TTag v-for="plan in (row.usagePlans as ApiKeySummary['usagePlans'])" :key="plan.id" size="sm" variant="soft">
              {{ plan.name || plan.id }}
            </TTag>
          </TStack>
          <TText v-else tone="muted" size="xs">{{ t('apiKeys.noPlans') }}</TText>
        </template>
      </TTable>
    </TCard>

    <TCard variant="outline">
      <template #header>
        <TStack direction="horizontal" gap="0.5rem" align="center">
          <TIcon name="aws-api-gateway" />
          <TText weight="semibold">{{ t('apiKeys.plansHeading') }}</TText>
        </TStack>
      </template>

      <TStack v-if="loading" direction="horizontal" justify="center" align="center">
        <TSpinner :label="t('apiKeys.loadingPlans')" />
      </TStack>

      <TEmptyState
        v-else-if="!planRows.length"
        :title="t('apiKeys.plansEmptyTitle')"
        :description="t('apiKeys.plansEmptyBody')"
      >
        <template #icon>
          <TIcon name="aws-api-gateway" />
        </template>
      </TEmptyState>

      <TTable
        v-else
        :columns="planColumns"
        :rows="planRows"
        row-key="id"
        :aria-label="t('apiKeys.plansTableLabel')"
      >
        <template #cell-id="{ row }">
          <TText family="mono" size="xs">{{ row.id }}</TText>
        </template>

        <template #cell-name="{ row }">
          <TStack direction="vertical" gap="0.15rem">
            <TText weight="semibold">{{ row.displayName }}</TText>
            <TText v-if="row.description" tone="muted" size="xs">{{ row.description }}</TText>
          </TStack>
        </template>

        <template #cell-stages="{ row }">
          <TStack v-if="(row.apiStages as UsagePlanSummary['apiStages']).length" direction="horizontal" gap="0.35rem" wrap>
            <TTag
              v-for="stage in (row.apiStages as UsagePlanSummary['apiStages'])"
              :key="`${stage.apiId}/${stage.stage}`"
              size="sm"
              variant="soft"
            >
              {{ stage.apiId }}/{{ stage.stage }}
            </TTag>
          </TStack>
          <TText v-else tone="muted" size="xs">{{ t('apiKeys.noStages') }}</TText>
        </template>

        <template #cell-throttle="{ row }">
          <TText tone="muted" size="xs">{{ row.throttleText }}</TText>
        </template>

        <template #cell-quota="{ row }">
          <TText tone="muted" size="xs">{{ row.quotaText }}</TText>
        </template>

        <template #cell-keys="{ row }">
          <TTag size="sm" variant="soft">{{ row.keyCount }}</TTag>
        </template>
      </TTable>
    </TCard>
  </TStack>
</template>
