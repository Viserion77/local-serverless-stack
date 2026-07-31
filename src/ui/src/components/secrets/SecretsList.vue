<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import {
  TCard, TButton, TStack, TGrid, TStat, TEmptyState,
  TSpinner, TAlert, TTag, TTable, TInput, TModal, TBadge, TText, TCodeBlock, TIcon, useToast,
} from '@treeui/vue';
import { api } from '../../services/api';
import type { SecretSummary, SecretDetail, SecretValue } from '../../services/api';
import { useI18n } from '../../i18n';

const toast = useToast();
const { t } = useI18n();

const secrets = ref<SecretSummary[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const search = ref('');
let timer: number | null = null;

// Detail modal state.
const modalOpen = ref(false);
const activeName = ref<string | null>(null);
const detail = ref<SecretDetail | null>(null);
const detailLoading = ref(false);
const revealed = ref<SecretValue | null>(null);
const revealing = ref(false);

// Computed rather than a module const: the labels must go through t() on every
// render so a language switch relabels the table without a reload.
const columns = computed(() => [
  { key: 'name', label: t('secrets.columnSecret') },
  { key: 'description', label: t('secrets.columnDescription') },
  { key: 'versions', label: t('secrets.columnVersions'), align: 'right' as const },
  { key: 'lastChanged', label: t('secrets.columnLastChanged') },
  { key: 'actions', label: '', align: 'right' as const },
]);

const rows = computed(() =>
  secrets.value
    .map(s => ({
      ...s,
      versions: s.versionCount,
      lastChanged: s.lastChangedDate ? new Date(s.lastChangedDate).toLocaleString() : '—',
      scheduledDeletion: Boolean(s.deletedDate),
    }))
    .sort((a, b) => a.name.localeCompare(b.name)),
);

const filteredRows = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return rows.value;
  return rows.value.filter(r =>
    r.name.toLowerCase().includes(q) ||
    (r.description || '').toLowerCase().includes(q),
  );
});

const totals = computed(() => ({
  secrets: secrets.value.length,
  versions: secrets.value.reduce((sum, s) => sum + s.versionCount, 0),
}));

// versionId → stages, flattened for display.
const versionRows = computed(() =>
  Object.entries(detail.value?.versionStages ?? {}).map(([versionId, stages]) => ({
    versionId,
    stages: stages.join(', '),
    current: stages.includes('AWSCURRENT'),
  })),
);

async function load() {
  try {
    const res = await api.listSecrets();
    secrets.value = res.secrets;
    error.value = null;
  } catch (err: any) {
    error.value = err.message || t('secrets.loadFailed');
  } finally {
    loading.value = false;
  }
}

async function openDetail(name: string) {
  activeName.value = name;
  modalOpen.value = true;
  detail.value = null;
  revealed.value = null;
  detailLoading.value = true;
  try {
    detail.value = await api.describeSecret(name);
  } catch (err: any) {
    toast.add({ title: t('secrets.detailFailed'), description: err.message, variant: 'danger' });
  } finally {
    detailLoading.value = false;
  }
}

async function reveal() {
  if (!activeName.value) return;
  revealing.value = true;
  try {
    revealed.value = await api.getSecretValue(activeName.value);
  } catch (err: any) {
    toast.add({ title: t('secrets.revealFailed'), description: err.message, variant: 'danger' });
  } finally {
    revealing.value = false;
  }
}

async function copyValue() {
  const value = revealed.value?.secretString ?? revealed.value?.secretBinary;
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    toast.add({ title: t('secrets.copiedToClipboard'), variant: 'success' });
  } catch {
    toast.add({ title: t('secrets.copyFailed'), variant: 'danger' });
  }
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
    <TGrid :columns="2" gap="1rem">
      <TStat :label="t('secrets.statSecrets')" :value="totals.secrets" tone="info" :loading="loading" />
      <TStat :label="t('secrets.statVersions')" :value="totals.versions" tone="success" :loading="loading" />
    </TGrid>

    <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
      {{ error }}
    </TAlert>

    <TCard variant="outline">
      <template #header>
        <TStack direction="horizontal" justify="space-between" align="center" gap="1rem">
          <!-- The header is literally the AWS brand name; the mark is the same
               identity in visual form. -->
          <TStack direction="horizontal" gap="0.5rem" align="center">
            <TIcon name="aws-secrets-manager" />
            <TText weight="semibold">Secrets Manager</TText>
          </TStack>
          <TStack direction="horizontal" align="center" gap="1rem">
            <TInput v-model="search" :placeholder="t('secrets.filterPlaceholder')" style="min-width: 16rem;" />
            <TText tone="muted" size="xs">{{ t('secrets.autoRefresh') }}</TText>
          </TStack>
        </TStack>
      </template>

      <TStack v-if="loading" direction="horizontal" justify="center" align="center">
        <TSpinner :label="t('secrets.loadingList')" />
      </TStack>

      <TEmptyState
        v-else-if="!rows.length"
        :title="t('secrets.emptyTitle')"
        :description="t('secrets.emptyBody')"
      >
        <template #icon>
          <TIcon name="aws-secrets-manager" />
        </template>
      </TEmptyState>

      <!-- Filter state, not a service state — stays a TreeUI functional icon. -->
      <TEmptyState
        v-else-if="!filteredRows.length"
        :title="t('secrets.noMatchTitle')"
        :description="t('secrets.noMatchBody', { query: search })"
      >
        <template #icon>
          <TIcon name="search-x" />
        </template>
      </TEmptyState>

      <TTable v-else :columns="columns" :rows="filteredRows" :aria-label="t('secrets.tableLabel')">
        <template #cell-name="{ row }">
          <TStack direction="horizontal" align="center" gap="0.5rem">
            <TText
              weight="semibold"
              style="cursor: pointer; text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 3px;"
              @click="openDetail(String(row.name))"
            >
              {{ row.name }}
            </TText>
            <TBadge v-if="row.scheduledDeletion" tone="warning" variant="soft">{{ t('secrets.deletionScheduled') }}</TBadge>
          </TStack>
        </template>

        <template #cell-description="{ row }">
          <TText tone="muted" size="sm">{{ row.description || '—' }}</TText>
        </template>

        <template #cell-versions="{ row }">
          <TTag size="sm" variant="soft">{{ row.versions }}</TTag>
        </template>

        <template #cell-lastChanged="{ row }">
          <TText tone="muted" family="mono" size="xs">{{ row.lastChanged }}</TText>
        </template>

        <template #cell-actions="{ row }">
          <TButton size="sm" variant="soft" @click="openDetail(String(row.name))">{{ t('secrets.inspect') }}</TButton>
        </template>
      </TTable>
    </TCard>

    <TModal
      v-model:open="modalOpen"
      :title="activeName ? t('secrets.detailTitle', { name: activeName }) : t('secrets.detailTitleFallback')"
      size="lg"
    >
      <TStack v-if="detailLoading" direction="horizontal" justify="center" align="center">
        <TSpinner :label="t('secrets.loadingDetail')" />
      </TStack>

      <TStack v-else-if="detail" direction="vertical" gap="1rem">
        <TStack direction="vertical" gap="0.35rem">
          <TText tone="muted" family="mono" size="xs" style="word-break: break-all;">{{ detail.arn }}</TText>
          <span v-if="detail.description">{{ detail.description }}</span>
        </TStack>

        <div>
          <TText weight="semibold" size="sm">{{ t('secrets.versionsHeading') }}</TText>
          <TTable
            :columns="[
              { key: 'versionId', label: t('secrets.columnVersion') },
              { key: 'stages', label: t('secrets.columnStagingLabels') },
            ]"
            :rows="versionRows"
            :aria-label="t('secrets.versionsTableLabel')"
          >
            <template #cell-versionId="{ row }">
              <TText family="mono" size="xs">{{ row.versionId }}</TText>
            </template>
            <template #cell-stages="{ row }">
              <TBadge :tone="row.current ? 'success' : 'neutral'" variant="soft">{{ row.stages }}</TBadge>
            </template>
          </TTable>
        </div>

        <TStack v-if="detail.tags.length" direction="horizontal" gap="0.5rem" wrap>
          <TTag v-for="tag in detail.tags" :key="tag.key" size="sm" variant="soft">{{ tag.key }}={{ tag.value }}</TTag>
        </TStack>

        <div>
          <TStack direction="horizontal" gap="0.5rem" align="center">
            <TButton size="sm" variant="solid" :loading="revealing" @click="reveal">
              {{ revealed ? t('secrets.refreshValue') : t('secrets.revealValue') }}
            </TButton>
            <TButton v-if="revealed" size="sm" variant="ghost" @click="copyValue">{{ t('common.copy') }}</TButton>
          </TStack>
          <TCodeBlock v-if="revealed" :code="revealed.secretString ?? t('secrets.binaryValue', { value: revealed.secretBinary ?? '' })" :label="t('secrets.valueLabel')" max-block-size="24rem" wrap copyable />
        </div>
      </TStack>
    </TModal>
  </TStack>
</template>
