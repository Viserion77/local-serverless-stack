<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  TButton, TBadge, TStack, TTabs, TTabList, TTab, TTabPanel, TSpinner, TAlert,
  TCard, TCodeBlock, TTag, TEmptyState, TGrid, TStat, TTable, TTextarea, TFormField,
  TSelect, TDivider, TText, TIcon, useToast,
} from '@treeui/vue';
import type { TreeBadgeTone } from '@treeui/vue';
import { api } from '../../services/api';
import type { InvokeResult, LambdaDetailInfo, LambdaInvocationRecord } from '../../services/api';

const props = defineProps<{ functionName: string }>();
const emit = defineEmits<{ (e: 'back'): void }>();

const route = useRoute();
const router = useRouter();
const toast = useToast();

const fn = ref<LambdaDetailInfo | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
let refreshTimer: number | null = null;

const VALID_TABS = ['invoke', 'triggers', 'environment', 'logs'] as const;
type TabValue = typeof VALID_TABS[number];

const activeTab = computed<TabValue>({
  get() {
    const q = String(route.query.tab || '');
    return (VALID_TABS as readonly string[]).includes(q) ? (q as TabValue) : 'invoke';
  },
  set(value) {
    router.replace({
      query: { ...route.query, tab: value === 'invoke' ? undefined : value },
    });
  },
});

// Invoke tab state
const payloadText = ref('{}');
const invocationType = ref<'RequestResponse' | 'Event'>('RequestResponse');
const invoking = ref(false);
const lastResult = ref<InvokeResult | null>(null);
const lastAccepted = ref(false);

const invocationTypeOptions = [
  { value: 'RequestResponse', label: 'RequestResponse (sync)' },
  { value: 'Event', label: 'Event (async, fire & forget)' },
];

// Logs tab state
const history = ref<LambdaInvocationRecord[]>([]);
const logsLoading = ref(false);
const expandedLogs = ref<Record<number, boolean>>({});

const envColumns = [
  { key: 'key', label: 'Key' },
  { key: 'value', label: 'Value' },
];

const envRows = computed(() =>
  Object.entries(fn.value?.environment || {}).map(([key, value]) => ({ key, value })),
);

const routesColumns = [
  { key: 'method', label: 'Method' },
  { key: 'path', label: 'Path' },
  { key: 'eventType', label: 'Type' },
  { key: 'authorizerName', label: 'Authorizer' },
];

const routesRows = computed(() => (fn.value?.routes || []).map(r => ({ ...r })));

const resultPayloadPretty = computed(() => {
  if (!lastResult.value) return '';
  const p = lastResult.value.payload;
  if (p === undefined) return '—';
  try {
    return JSON.stringify(p, null, 2);
  } catch {
    return String(p);
  }
});

async function load(showSpinner = true) {
  if (showSpinner) loading.value = true;
  try {
    fn.value = await api.getLambda(props.functionName);
    error.value = null;
  } catch (err: any) {
    error.value = err.message || 'Failed to load function';
    fn.value = null;
  } finally {
    loading.value = false;
  }
}

async function loadLogs() {
  logsLoading.value = true;
  try {
    const res = await api.getLambdaLogs(props.functionName);
    history.value = [...res.invocations].reverse();
  } catch (err: any) {
    toast.add({
      title: 'Failed to load invocation logs',
      description: err.message,
      variant: 'danger',
    });
  } finally {
    logsLoading.value = false;
  }
}

async function invoke() {
  let payload: unknown;
  const text = payloadText.value.trim();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      toast.add({
        title: 'Invalid JSON payload',
        description: 'Fix the payload before invoking.',
        variant: 'danger',
      });
      return;
    }
  }
  invoking.value = true;
  try {
    const result = await api.invokeLambda(props.functionName, {
      payload,
      invocationType: invocationType.value,
    });
    if (invocationType.value === 'Event') {
      lastResult.value = null;
      lastAccepted.value = true;
      toast.add({
        title: 'Invocation accepted',
        description: 'Event invocation queued (fire & forget).',
        variant: 'success',
      });
    } else {
      lastAccepted.value = false;
      lastResult.value = result as InvokeResult;
      if (!(result as InvokeResult).ok) {
        toast.add({
          title: 'Function returned an error',
          description: (result as InvokeResult).functionError?.errorMessage,
          variant: 'danger',
        });
      }
    }
    await load(false);
  } catch (err: any) {
    toast.add({
      title: 'Failed to invoke function',
      description: err.message,
      variant: 'danger',
    });
  } finally {
    invoking.value = false;
  }
}

function toggleLogs(idx: number) {
  expandedLogs.value[idx] = !expandedLogs.value[idx];
}

function statusTone(status?: string): TreeBadgeTone {
  switch (status) {
    case 'online': return 'success';
    case 'starting': return 'info';
    case 'stopped': return 'neutral';
    default: return 'danger';
  }
}

function methodTone(method: string): TreeBadgeTone {
  return method === 'ANY' ? 'info' : 'neutral';
}

function formatDate(ts?: number): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

onMounted(() => {
  load();
  loadLogs();
  refreshTimer = window.setInterval(() => load(false), 10000);
});

onBeforeUnmount(() => {
  if (refreshTimer) window.clearInterval(refreshTimer);
});

watch(() => props.functionName, () => {
  load();
  loadLogs();
});
</script>

<template>
  <TStack direction="vertical" gap="1rem">
    <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
      <TStack direction="horizontal" gap="0.5rem" align="center">
        <TButton size="sm" variant="ghost" @click="emit('back')"><TIcon name="arrow-left" /> Lambdas</TButton>
        <TText weight="semibold" size="lg">{{ functionName }}</TText>
        <TText v-if="fn" tone="muted" family="mono" size="xs">{{ fn.fullName }}</TText>
      </TStack>
      <TButton size="sm" variant="ghost" :loading="loading" @click="load()">Refresh</TButton>
    </TStack>

    <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
      {{ error }}
    </TAlert>

    <TStack v-if="loading && !fn" direction="horizontal" justify="center" align="center">
      <TSpinner label="Loading function..." />
    </TStack>

    <template v-else-if="fn">
      <TGrid :columns="5" gap="0.75rem">
        <TStat label="Status" :value="fn.status" :tone="statusTone(fn.status)" />
        <TStat label="Runtime" :value="fn.runtime" tone="info" />
        <TStat label="Memory" :value="`${fn.memorySize} MB`" tone="neutral" />
        <TStat label="Timeout" :value="`${fn.timeout}s`" tone="neutral" />
        <TStat label="Mode" :value="fn.executionMode || '—'" tone="neutral" />
      </TGrid>

      <TTabs v-model="activeTab">
        <TTabList>
          <TTab value="invoke">Invoke</TTab>
          <TTab value="triggers">Triggers</TTab>
          <TTab value="environment">Environment</TTab>
          <TTab value="logs">Logs</TTab>
        </TTabList>

        <TTabPanel value="invoke">
          <div style="padding-top: 1rem;">
            <TStack direction="vertical" gap="1rem">
              <TCard variant="outline">
                <template #header>
                  <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
                    <TText weight="semibold">Invoke function</TText>
                    <TText tone="muted" family="mono" size="xs">{{ fn.handler }}</TText>
                  </TStack>
                </template>

                <TStack direction="vertical" gap="0.75rem">
                  <TFormField label="Event payload" hint="JSON passed to the handler as the event">
                    <TTextarea
                      v-model="payloadText"
                      class="mono"
                      :rows="8"
                      placeholder="{}"
                    />
                  </TFormField>
                  <TFormField label="Invocation type" style="max-width: 20rem;">
                    <TSelect v-model="invocationType" :options="invocationTypeOptions" />
                  </TFormField>
                </TStack>

                <template #footer>
                  <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
                    <TStack direction="horizontal" gap="0.5rem" align="center">
                      <TButton variant="solid" :loading="invoking" @click="invoke">Invoke</TButton>
                      <TButton variant="ghost" :disabled="invoking" @click="payloadText = '{}'">
                        Reset payload
                      </TButton>
                    </TStack>
                    <TText v-if="lastAccepted" tone="muted" size="xs">
                      Last invocation accepted as Event — check the Logs tab for output.
                    </TText>
                  </TStack>
                </template>
              </TCard>

              <TCard v-if="lastResult" variant="outline">
                <template #header>
                  <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
                    <TStack direction="horizontal" gap="0.5rem" align="center">
                      <TText weight="semibold">Result</TText>
                      <TBadge :tone="lastResult.ok ? 'success' : 'danger'" variant="soft">
                        {{ lastResult.ok ? 'OK' : (lastResult.functionError?.errorType || 'Error') }}
                      </TBadge>
                    </TStack>
                    <TText tone="muted" family="mono" size="xs">
                      {{ lastResult.durationMs }}ms
                    </TText>
                  </TStack>
                </template>

                <TStack direction="vertical" gap="0.75rem">
                  <template v-if="lastResult.ok">
                    <TText weight="semibold" size="sm">Response payload</TText>
                    <TCodeBlock :code="resultPayloadPretty" label="Response payload" max-block-size="24rem" wrap copyable />
                  </template>
                  <template v-else>
                    <TText weight="semibold" size="sm">Function error</TText>
                    <TCodeBlock :code="[`${lastResult.functionError?.errorType || 'Error'}: ${lastResult.functionError?.errorMessage || ''}`, ...(lastResult.functionError?.trace || [])].join('\n')" label="Function error" max-block-size="60vh" wrap copyable />
                  </template>
                  <TDivider />
                  <TText weight="semibold" size="sm">Captured logs</TText>
                  <TCodeBlock :code="lastResult.logs.join('\n') || '— no output —'" label="Captured logs" max-block-size="60vh" wrap copyable />
                </TStack>
              </TCard>
            </TStack>
          </div>
        </TTabPanel>

        <TTabPanel value="triggers">
          <div style="padding-top: 1rem;">
            <TStack direction="vertical" gap="1rem">
              <TCard variant="outline">
                <template #header>
                  <TText weight="semibold">Trigger sources</TText>
                </template>
                <TStack direction="horizontal" gap="0.25rem" wrap>
                  <template v-if="fn.triggers.length">
                    <TTag v-for="t in fn.triggers" :key="t" size="sm" variant="soft">
                      {{ t }}
                    </TTag>
                  </template>
                  <TText v-else tone="muted">—</TText>
                </TStack>
              </TCard>

              <TCard variant="outline">
                <template #header>
                  <TText weight="semibold">HTTP routes</TText>
                </template>
                <TTable v-if="fn.routes.length" :columns="routesColumns" :rows="routesRows" aria-label="HTTP routes">
                  <template #cell-method="{ row }">
                    <TBadge :tone="methodTone(String(row.method))" variant="soft">
                      {{ row.method }}
                    </TBadge>
                  </template>
                  <template #cell-path="{ row }">
                    <TText family="mono">{{ row.path }}</TText>
                  </template>
                  <template #cell-eventType="{ row }">
                    <TTag size="sm" variant="soft">{{ row.eventType }}</TTag>
                  </template>
                  <template #cell-authorizerName="{ row }">
                    <TTag v-if="row.authorizerName" size="sm" variant="soft">
                      {{ row.authorizerName }}
                    </TTag>
                    <TText v-else tone="muted">—</TText>
                  </template>
                </TTable>
                <TEmptyState
                  v-else
                  title="No HTTP routes"
                  description="This function has no http/httpApi events pointing at it."
                />
              </TCard>
            </TStack>
          </div>
        </TTabPanel>

        <TTabPanel value="environment">
          <div style="padding-top: 1rem;">
            <TCard variant="outline">
              <template #header>
                <TText weight="semibold">Environment variables</TText>
              </template>
              <TTable v-if="envRows.length" :columns="envColumns" :rows="envRows" aria-label="Environment variables">
                <template #cell-key="{ row }">
                  <TText family="mono" style="font-size: 0.78rem;">{{ row.key }}</TText>
                </template>
                <template #cell-value="{ row }">
                  <TText family="mono" style="font-size: 0.78rem;">{{ row.value }}</TText>
                </template>
              </TTable>
              <TEmptyState
                v-else
                title="No environment variables"
                description="No environment variables are configured for this function."
              />
            </TCard>
          </div>
        </TTabPanel>

        <TTabPanel value="logs">
          <div style="padding-top: 1rem;">
            <TCard variant="outline">
              <template #header>
                <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
                  <TText weight="semibold">Recent invocations ({{ history.length }})</TText>
                  <TButton size="sm" variant="ghost" :loading="logsLoading" @click="loadLogs">
                    Refresh
                  </TButton>
                </TStack>
              </template>

              <TStack v-if="logsLoading && !history.length" direction="horizontal" justify="center" align="center">
                <TSpinner label="Loading invocations..." />
              </TStack>

              <TEmptyState
                v-else-if="!history.length"
                title="No invocations recorded"
                description="Invoke the function to see its captured output here."
              />

              <TStack v-else direction="vertical" gap="0.5rem">
                <TCard v-for="(rec, idx) in history" :key="`inv-${idx}`" variant="soft">
                  <TStack direction="vertical" gap="0.5rem">
                    <a
                      href="#"
                      style="text-decoration: none; color: inherit;"
                      @click.prevent="toggleLogs(idx)"
                    >
                      <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
                        <TStack direction="horizontal" gap="0.5rem" align="center">
                          <TIcon :name="expandedLogs[idx] ? 'chevron-down' : 'chevron-right'" />
                          <TText size="sm">{{ formatDate(rec.at) }}</TText>
                          <TBadge :tone="rec.ok ? 'success' : 'danger'" variant="soft">
                            {{ rec.ok ? 'OK' : 'Error' }}
                          </TBadge>
                          <TBadge
                            v-if="rec.statusCode && rec.statusCode >= 400"
                            :tone="rec.statusCode >= 500 ? 'danger' : 'warning'"
                            variant="soft"
                          >
                            HTTP {{ rec.statusCode }}
                          </TBadge>
                        </TStack>
                        <TText tone="muted" family="mono" size="xs">
                          {{ rec.durationMs }}ms · {{ rec.logs.length }} line{{ rec.logs.length === 1 ? '' : 's' }}
                        </TText>
                      </TStack>
                    </a>
                    <TCodeBlock v-if="expandedLogs[idx]" :code="rec.logs.join('\n') || '— no output —'" label="Invocation log" max-block-size="60vh" wrap copyable />
                  </TStack>
                </TCard>
              </TStack>
            </TCard>
          </div>
        </TTabPanel>
      </TTabs>
    </template>
  </TStack>
</template>
