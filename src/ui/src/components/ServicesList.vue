<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed } from 'vue';
import {
  TCard, TButton, TInput, TFormField, TBadge, TTable, TEmptyState,
  TStack, TModal, TConfirmDialog, TSpinner, TTag, TText, TIcon, TLink, TCodeBlock, useToast,
} from '@treeui/vue';
import type { TBadgeTone } from '@treeui/vue';

interface TableColumn {
  key: string;
  label: string;
  sortable?: boolean;
  align?: 'left' | 'center' | 'right';
  width?: string;
}
import { api } from '../services/api';
import type { ResourceBreakdown, ServiceSummary } from '../services/api';
import { ENGINE_LABEL } from '../services/engine';
import { breakdownEntries, breakdownOrder } from '../icons/resourceIcons';
import { useI18n } from '../i18n';

const { t } = useI18n();
const toast = useToast();
const services = ref<ServiceSummary[]>([]);
const loading = ref(true);
const registering = ref(false);
const newServicePath = ref('');
const logsService = ref<string | null>(null);
const logs = ref<string[]>([]);
const logsStatus = ref<'running' | 'stopped' | 'failed'>('stopped');
const logTimer = ref<number | null>(null);
const starting = ref<Record<string, boolean>>({});
const stopping = ref<Record<string, boolean>>({});
const deleteTarget = ref<string | null>(null);
const deleteDialogOpen = ref(false);
let refreshTimer: number | null = null;

// Computed, not a module-level const: the header labels have to be re-read
// through t() whenever the language changes, or the table keeps the labels it
// was built with.
const columns = computed<TableColumn[]>(() => [
  { key: 'name', label: t('common.name') },
  { key: 'status', label: t('common.status') },
  { key: 'root', label: t('services.path') },
  { key: 'resourceBreakdown', label: t('services.resources') },
  { key: 'lastUpdated', label: t('services.lastUpdated') },
  { key: 'actions', label: t('common.actions'), align: 'right' },
]);

const rows = computed(() => services.value.map(s => ({ ...s })));
const logsModalOpen = computed({
  get: () => logsService.value !== null,
  set: (value: boolean) => {
    if (!value) closeLogs();
  },
});

async function loadServices() {
  try {
    services.value = await api.listServices();
  } catch (error) {
    console.error('Failed to load services:', error);
  } finally {
    loading.value = false;
  }
}

async function startService(name: string) {
  if (starting.value[name]) return;
  starting.value = { ...starting.value, [name]: true };
  try {
    await api.startService(name);
    toast.add({ title: t('services.startedToast'), description: name, variant: 'success' });
    await loadServices();
  } catch (error: any) {
    toast.add({ title: t('services.startFailedToast'), description: error.message, variant: 'danger' });
  } finally {
    starting.value = { ...starting.value, [name]: false };
  }
}

async function stopService(name: string) {
  if (stopping.value[name]) return;
  stopping.value = { ...stopping.value, [name]: true };
  try {
    await api.stopService(name);
    toast.add({ title: t('services.stoppedToast'), description: name, variant: 'info' });
    await loadServices();
  } catch (error: any) {
    toast.add({ title: t('services.stopFailedToast'), description: error.message, variant: 'danger' });
  } finally {
    stopping.value = { ...stopping.value, [name]: false };
  }
}

async function fetchLogs(name: string) {
  try {
    const data = await api.getServiceLogs(name);
    logs.value = data.logs || [];
    logsStatus.value = data.status || 'stopped';
  } catch (error) {
    console.error('Failed to fetch logs:', error);
  }
}

function openLogs(name: string) {
  logsService.value = name;
  fetchLogs(name);
  if (logTimer.value) window.clearInterval(logTimer.value);
  logTimer.value = window.setInterval(() => fetchLogs(name), 2000);
}

function closeLogs() {
  logsService.value = null;
  logs.value = [];
  if (logTimer.value) window.clearInterval(logTimer.value);
  logTimer.value = null;
}

async function registerService() {
  if (!newServicePath.value.trim()) return;

  registering.value = true;
  try {
    await api.registerService(newServicePath.value);
    toast.add({ title: t('services.registeredToast'), description: newServicePath.value, variant: 'success' });
    newServicePath.value = '';
    await loadServices();
  } catch (error: any) {
    toast.add({ title: t('services.registerFailedToast'), description: error.message, variant: 'danger' });
  } finally {
    registering.value = false;
  }
}

function requestDelete(name: string) {
  deleteTarget.value = name;
  deleteDialogOpen.value = true;
}

async function confirmDelete() {
  if (!deleteTarget.value) return;
  const name = deleteTarget.value;
  try {
    await api.deleteService(name);
    toast.add({ title: t('services.deletedToast'), description: name, variant: 'info' });
    await loadServices();
  } catch (error: any) {
    toast.add({ title: t('services.deleteFailedToast'), description: error.message, variant: 'danger' });
  } finally {
    deleteTarget.value = null;
    deleteDialogOpen.value = false;
  }
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

/**
 * The resource counters of one row: what the service declares, each tag
 * carrying the AWS mark of the service it counts (see `icons/resourceIcons`).
 * Counters at zero — or absent, since the orchestrator omits the ones it never
 * saw — are dropped rather than shown as "0".
 *
 * Assembled from the shared table instead of eight near-identical blocks in the
 * template: order, mark and accessible name are data, and the detail screen has
 * to group by the same keys. The `TTable` slot types a row as
 * `Record<string, unknown>`, hence the cast to the shape the API guarantees.
 */
function breakdownTags(row: Record<string, unknown>) {
  const breakdown = row.resourceBreakdown as ResourceBreakdown | undefined;
  if (!breakdown) return [];
  return breakdownOrder
    .map(key => ({ key, count: breakdown[key] ?? 0, ...breakdownEntries[key] }))
    .filter(entry => entry.count > 0);
}

function statusTone(status: string): TBadgeTone {
  switch (status) {
    case 'running': return 'success';
    case 'registered': return 'warning';
    case 'stopped': return 'neutral';
    default: return 'danger';
  }
}

/**
 * The orchestrator reports the lifecycle state as an English enum; the badge
 * shows it translated. An unknown state falls through to the raw value rather
 * than a blank badge — a surprising string is still a usable bug report.
 */
function statusLabel(status: string): string {
  switch (status) {
    case 'running': return t('services.statusRunning');
    case 'registered': return t('services.statusRegistered');
    case 'stopped': return t('common.stopped');
    case 'failed': return t('services.statusFailed');
    case 'error': return t('services.statusError');
    default: return status;
  }
}

onMounted(() => {
  loadServices();
  refreshTimer = window.setInterval(loadServices, 10000);
});

onBeforeUnmount(() => {
  if (refreshTimer) window.clearInterval(refreshTimer);
  if (logTimer.value) window.clearInterval(logTimer.value);
});
</script>

<template>
  <TCard variant="outline">
    <template #header>
      <TStack direction="horizontal" gap="0.75rem" align="center" justify="space-between">
        <TText weight="semibold">{{ t('services.title') }}</TText>
        <TStack direction="horizontal" gap="0.5rem" align="center">
          <TFormField :hint="t('services.registerHint')" :htmlFor="'register-path'">
            <TInput
              v-model="newServicePath"
              :placeholder="t('services.registerPlaceholder')"
              :disabled="registering"
              @keyup.enter="registerService"
            />
          </TFormField>
          <TButton
            variant="solid"
            :loading="registering"
            :disabled="!newServicePath.trim()"
            @click="registerService"
          >
            {{ t('services.register') }}
          </TButton>
        </TStack>
      </TStack>
    </template>

    <TStack v-if="loading" direction="horizontal" justify="center" align="center">
      <TSpinner :label="t('services.loadingList')" />
    </TStack>

    <TEmptyState
      v-else-if="!services.length"
      :title="t('services.emptyTitle')"
      :description="t('services.emptyDescription')"
    />

    <TTable v-else :columns="columns" :rows="rows" :aria-label="t('services.tableLabel')">
      <template #cell-name="{ row }">
        <TLink :to="`/services/${encodeURIComponent(String(row.name))}`">
          <TText weight="semibold">
            {{ row.name }}
          </TText>
        </TLink>
      </template>

      <template #cell-status="{ row }">
        <TBadge :tone="statusTone(String(row.status))" variant="soft">
          {{ statusLabel(String(row.status)) }}
        </TBadge>
      </template>

      <template #cell-root="{ row }">
        <TText family="mono">{{ row.root }}</TText>
      </template>

      <template #cell-resourceBreakdown="{ row }">
        <TStack direction="horizontal" gap="0.25rem" wrap>
          <!--
            The mark stays in the tag's DEFAULT slot, not its `#icon` slot:
            TTag wraps `#icon` in `aria-hidden`, which is right when the tag has
            a visible label, but here the mark is the only thing that says which
            service the number belongs to. In the default slot TIcon's `label`
            names it, so a screen reader reads "SQS queues, 3" instead of "3".
          -->
          <TTag
            v-for="entry in breakdownTags(row)"
            :key="entry.key"
            size="sm"
            variant="soft"
          >
            <TIcon :name="entry.icon" :label="t(entry.labelKey)" /> {{ entry.count }}
          </TTag>
          <TText
            v-if="!row.resourcesCount"
            tone="muted"
            size="xs"
          >
            {{ t('common.none') }}
          </TText>
        </TStack>
      </template>

      <template #cell-lastUpdated="{ row }">
        {{ formatDate(Number(row.lastUpdated)) }}
      </template>

      <template #cell-actions="{ row }">
        <TStack direction="horizontal" gap="0.375rem" justify="flex-end" wrap>
          <TButton
            size="sm"
            variant="soft"
            :disabled="row.status === 'running' || starting[String(row.name)]"
            :loading="starting[String(row.name)]"
            @click="startService(String(row.name))"
          >
            {{ t('services.start') }}
          </TButton>
          <TButton
            size="sm"
            variant="soft"
            :disabled="row.status !== 'running' || stopping[String(row.name)]"
            :loading="stopping[String(row.name)]"
            @click="stopService(String(row.name))"
          >
            {{ t('services.stop') }}
          </TButton>
          <TButton size="sm" variant="ghost" @click="openLogs(String(row.name))">
            {{ t('services.logs') }}
          </TButton>
          <TButton
            size="sm"
            variant="danger"
            @click="requestDelete(String(row.name))"
          >
            {{ t('common.delete') }}
          </TButton>
        </TStack>
      </template>
    </TTable>

    <TModal
      v-model:open="logsModalOpen"
      :title="logsService ? t('services.logsTitleFor', { name: logsService }) : t('services.logsTitle')"
      :description="logsService ? t('services.logsStatus', { status: statusLabel(logsStatus) }) : ''"
      size="lg"
    >
      <TCodeBlock
        :code="logs.join('\n') || t('services.logsEmpty')"
        :label="t('services.logsLabel')"
        max-block-size="60vh"
        wrap
        copyable
      />
    </TModal>

    <TConfirmDialog
      v-model:open="deleteDialogOpen"
      :title="deleteTarget ? t('services.deleteTitleNamed', { name: deleteTarget }) : t('services.deleteTitle')"
      :description="t('services.deleteDescription', { engine: ENGINE_LABEL })"
      :confirm-label="t('common.delete')"
      :cancel-label="t('common.cancel')"
      @confirm="confirmDelete"
    />
  </TCard>
</template>
