<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { RouterLink } from 'vue-router';
import {
  TCard, TButton, TBadge, TTable, TEmptyState, TStack, TGrid, TStat,
  TTag, TSpinner, TAlert, TDivider, TText, TLink, useToast,
} from '@treeui/vue';
import type { TBadgeTone } from '@treeui/vue';
import { api } from '../../services/api';
import type { ApiRouteInfo, ServiceApiInfo } from '../../services/api';

const toast = useToast();
const apis = ref<ServiceApiInfo[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const clearingCache = ref<Record<string, boolean>>({});
let refreshTimer: number | null = null;

const routeColumns = [
  { key: 'method', label: 'Method' },
  { key: 'path', label: 'Path' },
  { key: 'functionName', label: '→ Function' },
  { key: 'eventType', label: 'Type' },
  { key: 'authorizerName', label: 'Auth' },
  { key: 'actions', label: '', align: 'right' as const },
];

const authorizerColumns = [
  { key: 'name', label: 'Name' },
  { key: 'type', label: 'Type' },
  { key: 'payloadVersion', label: 'Payload' },
  { key: 'resultTtlInSeconds', label: 'TTL', align: 'right' as const },
  { key: 'identitySource', label: 'Identity source' },
  { key: 'target', label: 'Function / ARN' },
];

const totals = computed(() => ({
  services: apis.value.length,
  routes: apis.value.reduce((s, a) => s + a.routes.length, 0),
  online: apis.value.filter(a => a.status === 'online').length,
}));

function routeRows(svc: ServiceApiInfo) {
  return svc.routes.map(r => ({ ...r }));
}

function authorizerRows(svc: ServiceApiInfo) {
  return svc.authorizers.map(a => ({
    ...a,
    identitySource: a.identitySource.join(', '),
    target: a.functionName || a.arn || '',
  }));
}

async function loadApis() {
  try {
    apis.value = await api.listApis();
    error.value = null;
  } catch (err: any) {
    error.value = err.message || 'Failed to load APIs';
  } finally {
    loading.value = false;
  }
}

async function clearCache(service: string) {
  if (clearingCache.value[service]) return;
  clearingCache.value = { ...clearingCache.value, [service]: true };
  try {
    const res = await api.clearAuthorizerCache({ service });
    toast.add({
      title: 'Authorizer cache cleared',
      description: `${res.removed} cached result${res.removed === 1 ? '' : 's'} removed`,
      variant: 'success',
    });
  } catch (err: any) {
    toast.add({
      title: 'Failed to clear authorizer cache',
      description: err.message,
      variant: 'danger',
    });
  } finally {
    clearingCache.value = { ...clearingCache.value, [service]: false };
  }
}

function copyCurl(svc: ServiceApiInfo, route: ApiRouteInfo) {
  const cmd = `curl -X ${route.method} http://localhost:${svc.apiPort}${route.path}`;
  navigator.clipboard?.writeText(cmd).then(() => {
    toast.add({ title: 'curl command copied', description: cmd, variant: 'success' });
  });
}

function listenerTone(status: string): TBadgeTone {
  switch (status) {
    case 'online': return 'success';
    case 'port-conflict': return 'warning';
    default: return 'neutral';
  }
}

function methodTone(method: string): TBadgeTone {
  return method === 'ANY' ? 'info' : 'neutral';
}

onMounted(() => {
  loadApis();
  refreshTimer = window.setInterval(loadApis, 10000);
});

onBeforeUnmount(() => {
  if (refreshTimer) window.clearInterval(refreshTimer);
});
</script>

<template>
  <TStack direction="vertical" gap="1.25rem">
    <TGrid :columns="3" gap="1rem">
      <TStat
        label="Services with APIs"
        :value="totals.services"
        tone="info"
        :loading="loading"
      />
      <TStat
        label="Routes"
        :value="totals.routes"
        tone="info"
        :loading="loading"
      />
      <TStat
        label="Listeners online"
        :value="totals.online"
        tone="success"
        :loading="loading"
      />
    </TGrid>

    <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
      {{ error }}
    </TAlert>

    <TStack v-if="loading && !apis.length" direction="horizontal" justify="center" align="center">
      <TSpinner label="Loading APIs..." />
    </TStack>

    <TEmptyState
      v-else-if="!apis.length"
      title="No APIs registered"
      description="Register a microservice that defines http or httpApi events to see its routes here."
    />

    <TCard
      v-for="svc in apis"
      :key="svc.service"
      variant="outline"
    >
      <template #header>
        <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between" wrap>
          <TStack direction="horizontal" gap="0.5rem" align="center" wrap>
            <TLink :to="`/services/${encodeURIComponent(svc.service)}`">
              <TText weight="semibold">{{ svc.service }}</TText>
            </TLink>
            <TBadge v-if="svc.apiPort" tone="info" variant="soft">:{{ svc.apiPort }}</TBadge>
            <TBadge :tone="listenerTone(svc.status)" variant="soft">{{ svc.status }}</TBadge>
            <TBadge
              v-if="svc.invokePort"
              :tone="listenerTone(svc.invokeStatus)"
              variant="soft"
            >
              invoke :{{ svc.invokePort }}
            </TBadge>
            <TTag v-if="svc.stage" size="sm" variant="soft">stage: {{ svc.stage }}</TTag>
          </TStack>
          <TButton
            size="sm"
            variant="ghost"
            :loading="clearingCache[svc.service]"
            @click="clearCache(svc.service)"
          >
            Clear authorizer cache
          </TButton>
        </TStack>
      </template>

      <TStack direction="vertical" gap="0.75rem">
        <TTable v-if="svc.routes.length" :columns="routeColumns" :rows="routeRows(svc)" aria-label="API routes">
          <template #cell-method="{ row }">
            <TBadge :tone="methodTone(String(row.method))" variant="soft">
              {{ row.method }}
            </TBadge>
          </template>

          <template #cell-path="{ row }">
            <TText family="mono">{{ row.path }}</TText>
          </template>

          <template #cell-functionName="{ row }">
            <RouterLink
              :to="`/lambdas/${encodeURIComponent(String(row.functionName))}`"
              style="text-decoration: none;"
            >
              <TTag size="sm" variant="soft" clickable>{{ row.functionName }}</TTag>
            </RouterLink>
          </template>

          <template #cell-eventType="{ row }">
            <TTag size="sm" variant="soft">
              {{ row.payloadVersion === '2.0' ? 'v2' : 'v1' }}
            </TTag>
          </template>

          <template #cell-authorizerName="{ row }">
            <TTag v-if="row.authorizerName" size="sm" variant="soft">
              {{ row.authorizerName }}
            </TTag>
            <TText v-else tone="muted">—</TText>
          </template>

          <template #cell-actions="{ row }">
            <TStack direction="horizontal" gap="0.375rem" justify="flex-end">
              <TButton
                size="sm"
                variant="ghost"
                @click="copyCurl(svc, row as unknown as ApiRouteInfo)"
              >
                Copy curl
              </TButton>
            </TStack>
          </template>
        </TTable>

        <TEmptyState
          v-else
          title="No routes"
          description="This service exposes no http or httpApi routes."
        />

        <template v-if="svc.authorizers.length">
          <TDivider />
          <TText weight="semibold" size="sm">Authorizers</TText>
          <TTable :columns="authorizerColumns" :rows="authorizerRows(svc)" aria-label="Authorizers">
            <template #cell-name="{ row }">
              <TText family="mono" size="sm">{{ row.name }}</TText>
            </template>
            <template #cell-type="{ row }">
              <TTag size="sm" variant="soft">{{ row.type }}</TTag>
            </template>
            <template #cell-payloadVersion="{ row }">
              <TTag size="sm" variant="soft">
                {{ row.payloadVersion === '2.0' ? 'v2' : 'v1' }}
              </TTag>
            </template>
            <template #cell-resultTtlInSeconds="{ row }">
              <TText family="mono" size="sm">{{ row.resultTtlInSeconds }}s</TText>
            </template>
            <template #cell-identitySource="{ row }">
              <TText family="mono" size="xs">
                {{ row.identitySource || '—' }}
              </TText>
            </template>
            <template #cell-target="{ row }">
              <TText v-if="row.target" family="mono" size="xs">
                {{ row.target }}
              </TText>
              <TText v-else tone="muted">—</TText>
            </template>
          </TTable>
        </template>
      </TStack>
    </TCard>
  </TStack>
</template>
