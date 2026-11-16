<script setup lang="ts">
// One Lambda Web Function: its endpoints (local URL, auth, revision weights,
// listener), its revisions with the state of each execution environment (the
// process running the app), the recent requests and the process logs.
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import {
  TButton, TBadge, TStack, TSpinner, TAlert, TCard, TCodeBlock, TTag, TEmptyState, TGrid,
  TStat, TTable, TText, TIcon, TLink, TAccordion, TAccordionItem, useToast,
} from '@treeui/vue';
import { api } from '../../services/api';
import type { WebFunctionDetailInfo, WebFunctionRevisionInfo } from '../../services/api';
import { useI18n } from '../../i18n';
import { webStateTone, webStateLabel, httpStatusTone } from './webFunctionState';

const props = defineProps<{ service: string; name: string }>();
const emit = defineEmits<{ (e: 'back'): void }>();

const { t } = useI18n();
const toast = useToast();

const fn = ref<WebFunctionDetailInfo | null>(null);
const loading = ref(true);
const restarting = ref(false);
const error = ref<string | null>(null);
let refreshTimer: number | null = null;

const endpointColumns = computed(() => [
  { key: 'name', label: t('webFunctions.endpoint') },
  { key: 'url', label: t('webFunctions.url') },
  { key: 'authType', label: t('webFunctions.auth') },
  { key: 'weights', label: t('webFunctions.weights') },
  { key: 'listener', label: t('webFunctions.listener') },
]);

const revisionColumns = computed(() => [
  { key: 'revision', label: t('webFunctions.revision') },
  { key: 'weight', label: t('webFunctions.weight'), align: 'right' as const },
  { key: 'state', label: t('webFunctions.environmentState') },
  { key: 'code', label: t('webFunctions.code') },
]);

const requestColumns = computed(() => [
  { key: 'at', label: t('webFunctions.time') },
  { key: 'request', label: t('webFunctions.path') },
  { key: 'status', label: t('webFunctions.status') },
  { key: 'durationMs', label: t('webFunctions.duration'), align: 'right' as const },
  { key: 'revisionId', label: t('webFunctions.revision') },
  { key: 'requestId', label: t('webFunctions.requestId') },
]);

// The weight a revision gets across the function's endpoints (the common case
// is one endpoint, so this is simply its RevisionWeights entry).
const weightByRevision = computed(() => {
  const weights = new Map<string, number>();
  for (const ep of fn.value?.endpoints ?? []) {
    for (const w of ep.weights) weights.set(w.revisionId, (weights.get(w.revisionId) ?? 0) + w.weight);
  }
  return weights;
});

const endpointRows = computed(() => (fn.value?.endpoints ?? []).map(ep => ({ ...ep, key: ep.name })));
const revisionRows = computed(() => (fn.value?.revisions ?? []).map(rev => ({ ...rev, key: rev.revisionId })));
const requestRows = computed(() => (fn.value?.recentRequests ?? []).map(r => ({ ...r, key: r.requestId })));

const logText = computed(() =>
  (fn.value?.logs ?? [])
    .map(line => `${new Date(line.at).toLocaleTimeString()} ${line.revisionId.slice(0, 6)} ${line.stream === 'stdout' ? '' : `[${line.stream}] `}${line.text}`)
    .join('\n'),
);

const maxTimeout = computed(() => Math.max(0, ...(fn.value?.revisions ?? []).map(rev => rev.timeoutSeconds)));
const maxConcurrency = computed(() => Math.max(0, ...(fn.value?.revisions ?? []).map(rev => rev.maxConcurrency)));
const runtimes = computed(() => [...new Set((fn.value?.revisions ?? []).map(rev => rev.runtime))].join(', ') || '—');

function revisionLabel(id?: string): string {
  const rev = fn.value?.revisions.find(r => r.revisionId === id);
  return rev ? rev.logicalId : (id ?? '—');
}

function listenerLabel(status: string): string {
  if (status === 'online') return t('webFunctions.listenerOnline');
  if (status === 'port-conflict') return t('webFunctions.listenerConflict');
  return t('webFunctions.listenerStopped');
}

function formatTime(ts?: number): string {
  return ts ? new Date(ts).toLocaleTimeString() : '—';
}

async function load(showSpinner = true) {
  if (showSpinner) loading.value = true;
  try {
    fn.value = await api.getWebFunction(props.service, props.name);
    error.value = null;
  } catch (err: any) {
    error.value = err.message || t('webFunctions.detailLoadFailed');
    fn.value = null;
  } finally {
    loading.value = false;
  }
}

async function restart() {
  restarting.value = true;
  try {
    await api.restartWebFunction(props.service, props.name);
    toast.add({ title: t('webFunctions.restartedTitle'), description: t('webFunctions.restartedDescription'), variant: 'success' });
    await load(false);
  } catch (err: any) {
    toast.add({ title: t('webFunctions.restartFailed'), description: err.message, variant: 'danger' });
  } finally {
    restarting.value = false;
  }
}

onMounted(() => {
  load();
  refreshTimer = window.setInterval(() => load(false), 5000);
});

onBeforeUnmount(() => {
  if (refreshTimer) window.clearInterval(refreshTimer);
});

watch(() => [props.service, props.name], () => load());
</script>

<template>
  <TStack direction="vertical" gap="1rem">
    <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
      <TStack direction="horizontal" gap="0.5rem" align="center">
        <TButton size="sm" variant="ghost" @click="emit('back')">
          <template #icon><TIcon name="arrow-left" /></template>
          {{ t('nav.lambdas') }}
        </TButton>
        <TIcon name="aws-lambda" />
        <TText weight="semibold" size="lg">{{ name }}</TText>
        <TTag size="sm" tone="info" variant="soft">{{ t('webFunctions.badge') }}</TTag>
        <TLink :to="`/services/${encodeURIComponent(service)}`" underline="none">
          <TTag size="sm" variant="soft">{{ service }}</TTag>
        </TLink>
      </TStack>
      <TStack direction="horizontal" gap="0.5rem" align="center">
        <TButton size="sm" variant="outline" :loading="restarting" @click="restart">
          <template #icon><TIcon name="rotate-cw" /></template>
          {{ t('webFunctions.restart') }}
        </TButton>
        <TButton size="sm" variant="ghost" :loading="loading" @click="load()">{{ t('common.refresh') }}</TButton>
      </TStack>
    </TStack>

    <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
      {{ error }}
    </TAlert>

    <TStack v-if="loading && !fn" direction="horizontal" justify="center" align="center">
      <TSpinner :label="t('webFunctions.loadingDetail')" />
    </TStack>

    <template v-else-if="fn">
      <TGrid :columns="5" gap="0.75rem">
        <TStat :label="t('webFunctions.statState')" :value="webStateLabel(fn.state, t)" :tone="webStateTone(fn.state)" />
        <TStat :label="t('lambdas.runtime')" :value="runtimes" tone="info" />
        <TStat :label="t('lambdas.timeout')" :value="`${maxTimeout}s`" tone="neutral" />
        <TStat :label="t('webFunctions.statConcurrency')" :value="maxConcurrency" tone="neutral" />
        <TStat
          :label="t('webFunctions.statRequests')"
          :value="fn.requests"
          :tone="fn.errors > 0 ? 'warning' : 'info'"
        />
      </TGrid>

      <TAlert v-if="fn.warnings.length" variant="warning">
        <TStack direction="vertical" gap="0.25rem">
          <TText weight="semibold">{{ t('webFunctions.warningsTitle') }}</TText>
          <TText v-for="warning in fn.warnings" :key="warning" size="sm">{{ warning }}</TText>
        </TStack>
      </TAlert>

      <TCard variant="outline">
        <template #header>
          <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
            <TText weight="semibold">{{ t('webFunctions.endpointsTitle') }}</TText>
            <TText tone="muted" size="xs">{{ t('webFunctions.httpNote') }}</TText>
          </TStack>
        </template>
        <TTable :columns="endpointColumns" :rows="endpointRows" row-key="key" :aria-label="t('webFunctions.endpointsTitle')">
          <template #cell-name="{ row }">
            <TStack direction="vertical" gap="0.125rem">
              <TText weight="semibold">{{ row.name }}</TText>
              <TText tone="muted" family="mono" size="xs">{{ row.endpointType }}</TText>
            </TStack>
          </template>
          <template #cell-url="{ row }">
            <TStack v-if="row.url" direction="vertical" gap="0.125rem">
              <TLink :href="String(row.url)" external family="mono" size="sm" :aria-label="t('webFunctions.openUrl', { url: String(row.url) })">
                {{ row.url }}
              </TLink>
              <TText tone="muted" family="mono" size="xs">DomainName = {{ row.domainName }}</TText>
            </TStack>
            <TText v-else tone="muted">{{ t('webFunctions.noUrl') }}</TText>
          </template>
          <template #cell-authType="{ row }">
            <TTag size="sm" :tone="row.authType === 'IamAuth' ? 'warning' : 'neutral'" variant="soft">{{ row.authType }}</TTag>
          </template>
          <template #cell-weights="{ row }">
            <TStack direction="horizontal" gap="0.25rem" wrap>
              <TTag
                v-for="w in (row.weights as Array<{ revisionId: string; weight: number }>)"
                :key="w.revisionId"
                size="sm"
                variant="soft"
              >
                {{ revisionLabel(w.revisionId) }} · {{ w.weight }}
              </TTag>
            </TStack>
          </template>
          <template #cell-listener="{ row }">
            <TBadge :tone="row.listener === 'online' ? 'success' : row.listener === 'port-conflict' ? 'warning' : 'neutral'" variant="soft">
              {{ listenerLabel(String(row.listener)) }}
            </TBadge>
          </template>
        </TTable>
      </TCard>

      <TCard variant="outline">
        <template #header>
          <TText weight="semibold">{{ t('webFunctions.revisionsTitle') }}</TText>
        </template>
        <TTable :columns="revisionColumns" :rows="revisionRows" row-key="key" :aria-label="t('webFunctions.revisionsTitle')">
          <template #cell-revision="{ row }">
            <TStack direction="vertical" gap="0.125rem">
              <TText weight="semibold">{{ row.logicalId }}</TText>
              <TText tone="muted" family="mono" size="xs">{{ row.revisionId }} · {{ row.runtime }} · {{ row.timeoutSeconds }}s · ×{{ row.maxConcurrency }}</TText>
              <TText v-if="row.description" tone="muted" size="xs">{{ row.description }}</TText>
            </TStack>
          </template>
          <template #cell-weight="{ row }">
            <TText family="mono">{{ weightByRevision.get(String(row.revisionId)) ?? 0 }}</TText>
          </template>
          <template #cell-state="{ row }">
            <TStack direction="vertical" gap="0.125rem">
              <TStack direction="horizontal" gap="0.375rem" align="center">
                <TBadge :tone="webStateTone(String(row.state))" variant="soft">{{ webStateLabel(String(row.state), t) }}</TBadge>
                <TText v-if="row.pid" tone="muted" family="mono" size="xs">{{ t('webFunctions.pid', { pid: Number(row.pid) }) }}</TText>
              </TStack>
              <TText v-if="row.state === 'ready'" tone="muted" size="xs">
                {{ t('webFunctions.inFlight', { inFlight: Number(row.inFlight), queued: Number(row.queued) }) }}
                <template v-if="row.coldStartMs !== undefined"> · {{ t('webFunctions.coldStart', { ms: Number(row.coldStartMs) }) }}</template>
              </TText>
              <TText v-if="row.error" tone="danger" size="xs">{{ row.errorType }}: {{ row.error }}</TText>
            </TStack>
          </template>
          <template #cell-code="{ row }">
            <TStack direction="vertical" gap="0.125rem">
              <TStack direction="horizontal" gap="0.375rem" align="center">
                <TTag size="sm" :tone="(row as unknown as WebFunctionRevisionInfo).code.source === 'missing' ? 'danger' : 'neutral'" variant="soft">
                  {{ t(`webFunctions.codeSource_${(row as unknown as WebFunctionRevisionInfo).code.source}`) }}
                </TTag>
                <TText family="mono" size="xs">{{ (row as unknown as WebFunctionRevisionInfo).code.entry }}</TText>
              </TStack>
              <TText tone="muted" size="xs">{{ (row as unknown as WebFunctionRevisionInfo).code.reason }}</TText>
            </TStack>
          </template>
        </TTable>

        <TAccordion type="multiple">
          <TAccordionItem v-for="rev in fn.revisions" :key="rev.revisionId" :value="rev.revisionId">
            <template #trigger>
              <TText size="sm">{{ t('webFunctions.environmentTitle') }} · {{ rev.logicalId }}</TText>
            </template>
            <TCodeBlock
              :code="Object.entries(fn.environment[rev.revisionId] ?? {}).map(([k, v]) => `${k}=${v}`).join('\n') || t('webFunctions.environmentEmpty')"
              :label="t('webFunctions.environmentTitle')"
              max-block-size="20rem"
              wrap
              copyable
            />
          </TAccordionItem>
        </TAccordion>
      </TCard>

      <!-- Stacked, not side by side: the request table needs its width (path,
           request id) and the log block reads better long than narrow. -->
      <TStack direction="vertical" gap="1rem">
        <TCard variant="outline">
          <template #header>
            <TText weight="semibold">{{ t('webFunctions.requestsTitle') }}</TText>
          </template>
          <TTable v-if="requestRows.length" :columns="requestColumns" :rows="requestRows" row-key="key" size="sm" :aria-label="t('webFunctions.requestsTitle')">
            <template #cell-at="{ row }">
              <TStack direction="vertical" gap="0.125rem">
                <TText size="sm">{{ formatTime(Number(row.at)) }}</TText>
                <TTag v-if="row.coldStart" size="sm" tone="info" variant="soft">{{ t('webFunctions.coldBadge') }}</TTag>
              </TStack>
            </template>
            <template #cell-request="{ row }">
              <TText family="mono" size="sm">{{ row.method }} {{ row.path }}</TText>
            </template>
            <template #cell-status="{ row }">
              <TStack direction="vertical" gap="0.125rem">
                <TBadge :tone="httpStatusTone(Number(row.status))" variant="soft">{{ row.status }}</TBadge>
                <TText v-if="row.errorType" tone="muted" family="mono" size="xs">{{ row.errorType }}</TText>
              </TStack>
            </template>
            <template #cell-durationMs="{ row }">
              <TText family="mono" size="sm">{{ row.durationMs }}ms</TText>
            </template>
            <template #cell-revisionId="{ row }">
              <TText size="sm">{{ revisionLabel(row.revisionId as string | undefined) }}</TText>
            </template>
            <template #cell-requestId="{ row }">
              <TText family="mono" size="xs">{{ String(row.requestId).slice(0, 8) }}</TText>
            </template>
          </TTable>
          <TEmptyState
            v-else
            :title="t('webFunctions.requestsEmptyTitle')"
            :description="t('webFunctions.requestsEmptyDescription')"
          />
        </TCard>

        <TCard variant="outline">
          <template #header>
            <TStack direction="vertical" gap="0.125rem">
              <TText weight="semibold">{{ t('webFunctions.logsTitle') }}</TText>
              <TText tone="muted" size="xs">{{ t('webFunctions.logsHint') }}</TText>
            </TStack>
          </template>
          <TCodeBlock :code="logText || t('webFunctions.logsEmpty')" :label="t('webFunctions.logsTitle')" max-block-size="28rem" wrap copyable />
        </TCard>
      </TStack>
    </template>
  </TStack>
</template>
