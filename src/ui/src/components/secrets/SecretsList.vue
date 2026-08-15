<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import {
  TCard, TButton, TStack, TStackItem, TGrid, TStat, TEmptyState,
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

// Row activation opens a modal, not a route — a revealed secret has no URL —
// so this is `rowActivatable` + `@row-activate`, never `rowTo`. TTable treats
// the two as mutually exclusive and warns in dev if both are passed.
//
// Since 0.30 activation is a real <button> in the first cell, not a
// `<tr role="button">`. That is what makes this screen expressible at all: the
// old role turned every cell presentational, so the Inspect button below
// stopped being announced — a row that activates AND holds a control had no
// accessible shape.
function onRowActivate(row: Record<string, unknown>) {
  openDetail(String(row.name));
}

// The activation button's accessible name. Without it the name is the whole
// row's text; it runs per render, so t() follows a language switch.
function rowLabel(row: Record<string, unknown>): string {
  return t('secrets.openSecretLabel', { name: String(row.name) });
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
            <!-- The floor is the flex item's, not the field's: TInput's `width`
                 is a cap (TFieldWidth), never a minimum. -->
            <TStackItem min-width="16rem">
              <TInput
                v-model="search"
                :placeholder="t('secrets.filterPlaceholder')"
                :aria-label="t('secrets.filterLabel')"
              />
            </TStackItem>
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

      <TTable
        v-else
        :columns="columns"
        :rows="filteredRows"
        row-key="name"
        row-activatable
        :row-label="rowLabel"
        :aria-label="t('secrets.tableLabel')"
        @row-activate="onRowActivate"
      >
        <template #cell-name="{ row }">
          <TStack direction="horizontal" align="center" gap="0.5rem">
            <!-- Plain text: the row carries the role, the keyboard handling and
                 the affordance (cursor, hover, focus ring), so the hand-rolled
                 `cursor:pointer` + dotted underline is gone with it. -->
            <TText weight="semibold">{{ row.name }}</TText>
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
          <!-- No `.stop`: activation is a <button> in the FIRST cell, so this
               one is its sibling, not its descendant, and the click has nothing
               to bubble into. The guard existed because activation used to be a
               click handler on the <tr>. -->
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
          <!-- An ARN is one ~80-character token with no break opportunity, and
               `truncate` is the wrong answer here: the suffix is what
               identifies the version. `wrap="anywhere"` also sets
               `min-inline-size: 0`, without which this flex child refuses to
               shrink below the longest word and never wraps. -->
          <TText tone="muted" family="mono" size="xs" wrap="anywhere">{{ detail.arn }}</TText>
          <TText v-if="detail.description">{{ detail.description }}</TText>
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
            <!-- `loading-label`: TButton's spinner label defaults to the
                 English literal "Loading" and is read as part of the button's
                 accessible name while busy — an untranslated string in a
                 trilingual UI (rule 6). -->
            <TButton
              size="sm"
              variant="solid"
              :loading="revealing"
              :loading-label="t('common.loading')"
              @click="reveal"
            >
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
