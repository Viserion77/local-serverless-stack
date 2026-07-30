<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed } from 'vue';
import {
  TCard, TButton, TInput, TFormField, TBadge, TTable, TEmptyState,
  TStack, TModal, TConfirmDialog, TSpinner, TTag, TText, TIcon, TLink, TCodeBlock, useToast,
} from '@treeui/vue';
import type { TreeBadgeTone } from '@treeui/vue';

interface TableColumn {
  key: string;
  label: string;
  sortable?: boolean;
  align?: 'left' | 'center' | 'right';
  width?: string;
}
import { api } from '../services/api';
import type { ServiceSummary } from '../services/api';
import { engineLabel } from '../services/engine';

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

const columns: TableColumn[] = [
  { key: 'name', label: 'Name' },
  { key: 'status', label: 'Status' },
  { key: 'root', label: 'Path' },
  { key: 'resourceBreakdown', label: 'Resources' },
  { key: 'lastUpdated', label: 'Last updated' },
  { key: 'actions', label: 'Actions', align: 'right' },
];

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
    toast.add({ title: 'Service started', description: name, variant: 'success' });
    await loadServices();
  } catch (error: any) {
    toast.add({ title: 'Failed to start service', description: error.message, variant: 'danger' });
  } finally {
    starting.value = { ...starting.value, [name]: false };
  }
}

async function stopService(name: string) {
  if (stopping.value[name]) return;
  stopping.value = { ...stopping.value, [name]: true };
  try {
    await api.stopService(name);
    toast.add({ title: 'Service stopped', description: name, variant: 'info' });
    await loadServices();
  } catch (error: any) {
    toast.add({ title: 'Failed to stop service', description: error.message, variant: 'danger' });
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
    toast.add({ title: 'Service registered', description: newServicePath.value, variant: 'success' });
    newServicePath.value = '';
    await loadServices();
  } catch (error: any) {
    toast.add({ title: 'Failed to register service', description: error.message, variant: 'danger' });
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
    toast.add({ title: 'Service deleted', description: name, variant: 'info' });
    await loadServices();
  } catch (error: any) {
    toast.add({ title: 'Failed to delete service', description: error.message, variant: 'danger' });
  } finally {
    deleteTarget.value = null;
    deleteDialogOpen.value = false;
  }
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function statusTone(status: string): TreeBadgeTone {
  switch (status) {
    case 'running': return 'success';
    case 'registered': return 'warning';
    case 'stopped': return 'neutral';
    default: return 'danger';
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
        <TText weight="semibold">Microservices</TText>
        <TStack direction="horizontal" gap="0.5rem" align="center">
          <TFormField hint="Absolute path to a Serverless project" :htmlFor="'register-path'">
            <TInput
              v-model="newServicePath"
              placeholder="/path/to/microservice"
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
            Register
          </TButton>
        </TStack>
      </TStack>
    </template>

    <TStack v-if="loading" direction="horizontal" justify="center" align="center">
      <TSpinner label="Loading services..." />
    </TStack>

    <TEmptyState
      v-else-if="!services.length"
      title="No services registered"
      description="Register your first microservice using the form above."
    />

    <TTable v-else :columns="columns" :rows="rows" aria-label="Registered microservices">
      <template #cell-name="{ row }">
        <TLink :to="`/services/${encodeURIComponent(String(row.name))}`">
          <TText weight="semibold">
            {{ row.name }}
          </TText>
        </TLink>
      </template>

      <template #cell-status="{ row }">
        <TBadge :tone="statusTone(String(row.status))" variant="soft">
          {{ row.status }}
        </TBadge>
      </template>

      <template #cell-root="{ row }">
        <TText family="mono">{{ row.root }}</TText>
      </template>

      <template #cell-resourceBreakdown="{ row }">
        <TStack direction="horizontal" gap="0.25rem" wrap>
          <TTag
            v-if="(row.resourceBreakdown as any)?.lambdas"
            size="sm"
            variant="soft"
          >
            <TIcon name="code" /> {{ (row.resourceBreakdown as any).lambdas }}
          </TTag>
          <TTag
            v-if="(row.resourceBreakdown as any)?.tables"
            size="sm"
            variant="soft"
          >
            <TIcon name="database" /> {{ (row.resourceBreakdown as any).tables }}
          </TTag>
          <TTag
            v-if="(row.resourceBreakdown as any)?.queues"
            size="sm"
            variant="soft"
          >
            <TIcon name="inbox" /> {{ (row.resourceBreakdown as any).queues }}
          </TTag>
          <TTag
            v-if="(row.resourceBreakdown as any)?.topics"
            size="sm"
            variant="soft"
          >
            <TIcon name="megaphone" /> {{ (row.resourceBreakdown as any).topics }}
          </TTag>
          <TTag
            v-if="(row.resourceBreakdown as any)?.buckets"
            size="sm"
            variant="soft"
          >
            <TIcon name="archive" /> {{ (row.resourceBreakdown as any).buckets }}
          </TTag>
          <TTag
            v-if="(row.resourceBreakdown as any)?.buses"
            size="sm"
            variant="soft"
          >
            <TIcon name="shuffle" /> {{ (row.resourceBreakdown as any).buses }}
          </TTag>
          <TTag
            v-if="(row.resourceBreakdown as any)?.eventRules"
            size="sm"
            variant="soft"
          >
            <TIcon name="target" /> {{ (row.resourceBreakdown as any).eventRules }}
          </TTag>
          <TTag
            v-if="(row.resourceBreakdown as any)?.collections"
            size="sm"
            variant="soft"
          >
            <TIcon name="search" /> {{ (row.resourceBreakdown as any).collections }}
          </TTag>
          <TText
            v-if="!row.resourcesCount"
            tone="muted"
            size="xs"
          >
            none
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
            Start
          </TButton>
          <TButton
            size="sm"
            variant="soft"
            :disabled="row.status !== 'running' || stopping[String(row.name)]"
            :loading="stopping[String(row.name)]"
            @click="stopService(String(row.name))"
          >
            Stop
          </TButton>
          <TButton size="sm" variant="ghost" @click="openLogs(String(row.name))">
            Logs
          </TButton>
          <TButton
            size="sm"
            variant="danger"
            @click="requestDelete(String(row.name))"
          >
            Delete
          </TButton>
        </TStack>
      </template>
    </TTable>

    <TModal
      v-model:open="logsModalOpen"
      :title="logsService ? `Logs — ${logsService}` : 'Logs'"
      :description="logsService ? `Status: ${logsStatus}` : ''"
      size="lg"
    >
      <TCodeBlock :code="logs.join('\n') || '— no output yet —'" label="Service log" max-block-size="60vh" wrap copyable />
    </TModal>

    <TConfirmDialog
      v-model:open="deleteDialogOpen"
      :title="`Delete service${deleteTarget ? ` “${deleteTarget}”` : ''}?`"
      :description="`This removes the service from the cache and cleans up its provisioned resources on the ${engineLabel}.`"
      confirm-label="Delete"
      cancel-label="Cancel"
      confirm-variant="danger"
      @confirm="confirmDelete"
    />
  </TCard>
</template>
