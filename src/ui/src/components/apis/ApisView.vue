<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { RouterLink } from 'vue-router';
import {
  TCard, TButton, TBadge, TTable, TEmptyState, TStack, TGrid, TStat,
  TTag, TSpinner, TAlert, TDivider, TText, TLink, TIcon, useToast,
} from '@treeui/vue';
import type { TBadgeTone } from '@treeui/vue';
import { api } from '../../services/api';
import type { ApiRouteInfo, ServiceApiInfo } from '../../services/api';
import { useI18n } from '../../i18n';

const { t } = useI18n();
const toast = useToast();
const apis = ref<ServiceApiInfo[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const clearingCache = ref<Record<string, boolean>>({});
let refreshTimer: number | null = null;

// Computed rather than module consts: the labels have to be re-read on a
// language switch, and a plain array would freeze the first locale's strings.
const routeColumns = computed(() => [
  { key: 'method', label: t('apis.colMethod') },
  { key: 'path', label: t('apis.colPath') },
  { key: 'functionName', label: `→ ${t('apis.colFunction')}` },
  { key: 'eventType', label: t('common.type') },
  { key: 'authorizerName', label: t('apis.colAuth') },
  { key: 'actions', label: '', align: 'right' as const },
]);

const authorizerColumns = computed(() => [
  { key: 'name', label: t('common.name') },
  { key: 'type', label: t('common.type') },
  { key: 'payloadVersion', label: t('apis.colPayload') },
  // TTL is the AWS field name (`resultTtlInSeconds`) — left untranslated.
  { key: 'resultTtlInSeconds', label: 'TTL', align: 'right' as const },
  { key: 'identitySource', label: t('apis.colIdentitySource') },
  { key: 'target', label: t('apis.colTarget') },
]);

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
    error.value = err.message || t('apis.loadError');
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
      title: t('apis.cacheCleared'),
      description: res.removed === 1
        ? t('apis.cacheClearedOne', { count: res.removed })
        : t('apis.cacheClearedMany', { count: res.removed }),
      variant: 'success',
    });
  } catch (err: any) {
    toast.add({
      title: t('apis.cacheClearFailed'),
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
    toast.add({ title: t('apis.curlCopied'), description: cmd, variant: 'success' });
  });
}

function listenerTone(status: string): TBadgeTone {
  switch (status) {
    case 'online': return 'success';
    case 'port-conflict': return 'warning';
    default: return 'neutral';
  }
}

// The listener status arrives as a `GatewayListenerStatus` literal; the badge
// shows the translated word, not the wire value.
function listenerLabel(status: string): string {
  switch (status) {
    case 'online': return t('common.online');
    case 'stopped': return t('common.stopped');
    case 'disabled': return t('common.disabled');
    case 'port-conflict': return t('apis.statusPortConflict');
    default: return t('common.unknown');
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
        :label="t('apis.statServices')"
        :value="totals.services"
        tone="info"
        :loading="loading"
      />
      <!-- Routes are the Amazon API Gateway resource, so this tile carries the
           brand. Its neighbours count LSS microservices and LSS gateway
           listeners and deliberately stay unbranded. -->
      <TStat
        :label="t('apis.statRoutes')"
        :value="totals.routes"
        tone="info"
        :loading="loading"
      >
        <template #icon>
          <TIcon name="aws-api-gateway" />
        </template>
      </TStat>
      <TStat
        :label="t('apis.statListenersOnline')"
        :value="totals.online"
        tone="success"
        :loading="loading"
      />
    </TGrid>

    <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
      {{ error }}
    </TAlert>

    <TStack v-if="loading && !apis.length" direction="horizontal" justify="center" align="center">
      <TSpinner :label="t('apis.loadingApis')" />
    </TStack>

    <TEmptyState
      v-else-if="!apis.length"
      :title="t('apis.emptyTitle')"
      :description="t('apis.emptyDescription')"
    >
      <template #icon>
        <TIcon name="aws-api-gateway" />
      </template>
    </TEmptyState>

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
            <TBadge :tone="listenerTone(svc.status)" variant="soft">
              {{ listenerLabel(svc.status) }}
            </TBadge>
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
            {{ t('apis.clearCache') }}
          </TButton>
        </TStack>
      </template>

      <TStack direction="vertical" gap="0.75rem">
        <TTable
          v-if="svc.routes.length"
          :columns="routeColumns"
          :rows="routeRows(svc)"
          :aria-label="t('apis.routesTableLabel')"
        >
          <template #cell-method="{ row }">
            <TBadge :tone="methodTone(String(row.method))" variant="soft">
              {{ row.method }}
            </TBadge>
          </template>

          <template #cell-path="{ row }">
            <TText family="mono">{{ row.path }}</TText>
          </template>

          <!-- Every route target is a Lambda function: the mark makes the
               API Gateway -> Lambda hop legible inside the table. Decorative
               (the tag names the function), and sized down so the filled tile
               does not outweigh a `sm` tag. -->
          <template #cell-functionName="{ row }">
            <RouterLink
              :to="`/lambdas/${encodeURIComponent(String(row.functionName))}`"
              style="text-decoration: none;"
            >
              <TTag size="sm" variant="soft" clickable>
                <template #icon><TIcon name="aws-lambda" size="14" /></template>
                {{ row.functionName }}
              </TTag>
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
                {{ t('apis.copyCurl') }}
              </TButton>
            </TStack>
          </template>
        </TTable>

        <TEmptyState
          v-else
          :title="t('apis.noRoutesTitle')"
          :description="t('apis.noRoutesDescription')"
        />

        <template v-if="svc.authorizers.length">
          <TDivider />
          <TText weight="semibold" size="sm">{{ t('apis.authorizers') }}</TText>
          <TTable
            :columns="authorizerColumns"
            :rows="authorizerRows(svc)"
            :aria-label="t('apis.authorizers')"
          >
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
