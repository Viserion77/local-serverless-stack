<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import {
  TCard, TButton, TStack, TGrid, TStat, TEmptyState,
  TSpinner, TAlert, TTag, TTable, TInput, TModal, TBadge, TText, useToast,
} from '@treeui/vue';
import { api } from '../../services/api';
import type { SecretSummary, SecretDetail, SecretValue } from '../../services/api';

const toast = useToast();

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

const columns = [
  { key: 'name', label: 'Secret' },
  { key: 'description', label: 'Description' },
  { key: 'versions', label: 'Versions', align: 'right' as const },
  { key: 'lastChanged', label: 'Last changed' },
  { key: 'actions', label: '', align: 'right' as const },
];

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
    error.value = err.message || 'Failed to load secrets';
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
    toast.add({ title: 'Failed to load secret', description: err.message, variant: 'danger' });
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
    toast.add({ title: 'Failed to reveal value', description: err.message, variant: 'danger' });
  } finally {
    revealing.value = false;
  }
}

async function copyValue() {
  const value = revealed.value?.secretString ?? revealed.value?.secretBinary;
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    toast.add({ title: 'Copied to clipboard', variant: 'success' });
  } catch {
    toast.add({ title: 'Copy failed', variant: 'danger' });
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
      <TStat label="Secrets" :value="totals.secrets" tone="info" :loading="loading" />
      <TStat label="Versions" :value="totals.versions" tone="success" :loading="loading" />
    </TGrid>

    <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
      {{ error }}
    </TAlert>

    <TCard variant="outline">
      <template #header>
        <TStack direction="horizontal" justify="space-between" align="center" gap="1rem">
          <TText weight="semibold">Secrets Manager</TText>
          <TStack direction="horizontal" align="center" gap="1rem">
            <TInput v-model="search" placeholder="Filter secrets..." style="min-width: 16rem;" />
            <TText tone="muted" size="xs">Refreshes every 15s</TText>
          </TStack>
        </TStack>
      </template>

      <TStack v-if="loading" direction="horizontal" justify="center" align="center">
        <TSpinner label="Loading secrets..." />
      </TStack>

      <TEmptyState
        v-else-if="!rows.length"
        title="No secrets"
        description="Create one with the AWS SDK (CreateSecret) against the engine endpoint — e.g. a signing key an identity service reads at boot."
      />

      <TEmptyState
        v-else-if="!filteredRows.length"
        title="No matching secrets"
        :description="`No secrets match &quot;${search}&quot;.`"
      />

      <TTable v-else :columns="columns" :rows="filteredRows" aria-label="Secrets">
        <template #cell-name="{ row }">
          <TStack direction="horizontal" align="center" gap="0.5rem">
            <TText
              weight="semibold"
              style="cursor: pointer; text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 3px;"
              @click="openDetail(String(row.name))"
            >
              {{ row.name }}
            </TText>
            <TBadge v-if="row.scheduledDeletion" tone="warning" variant="soft">deletion scheduled</TBadge>
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
          <TButton size="sm" variant="soft" @click="openDetail(String(row.name))">Inspect</TButton>
        </template>
      </TTable>
    </TCard>

    <TModal
      v-model:open="modalOpen"
      :title="activeName ? `Secret — ${activeName}` : 'Secret'"
      size="lg"
    >
      <TStack v-if="detailLoading" direction="horizontal" justify="center" align="center">
        <TSpinner label="Loading secret..." />
      </TStack>

      <TStack v-else-if="detail" direction="vertical" gap="1rem">
        <TStack direction="vertical" gap="0.35rem">
          <TText tone="muted" family="mono" size="xs" style="word-break: break-all;">{{ detail.arn }}</TText>
          <span v-if="detail.description">{{ detail.description }}</span>
        </TStack>

        <div>
          <TText weight="semibold" size="sm">Versions &amp; staging labels</TText>
          <TTable
            :columns="[
              { key: 'versionId', label: 'Version' },
              { key: 'stages', label: 'Staging labels' },
            ]"
            :rows="versionRows"
            aria-label="Secret versions and staging labels"
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
          <TTag v-for="t in detail.tags" :key="t.key" size="sm" variant="soft">{{ t.key }}={{ t.value }}</TTag>
        </TStack>

        <div>
          <TStack direction="horizontal" gap="0.5rem" align="center">
            <TButton size="sm" variant="solid" :loading="revealing" @click="reveal">
              {{ revealed ? 'Refresh value' : 'Reveal current value' }}
            </TButton>
            <TButton v-if="revealed" size="sm" variant="ghost" @click="copyValue">Copy</TButton>
          </TStack>
          <pre v-if="revealed" class="secret-value">{{ revealed.secretString ?? `(binary, base64) ${revealed.secretBinary}` }}</pre>
        </div>
      </TStack>
    </TModal>
  </TStack>
</template>

<style scoped>
.secret-value {
  margin-top: 0.6rem;
  padding: 0.6rem 0.75rem;
  border-radius: 6px;
  background: var(--tree-color-surface-sunken, rgba(127, 127, 127, 0.1));
  font-family: var(--tree-font-mono, monospace);
  font-size: 0.8rem;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
