<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  TButton, TBadge, TStack, TTabs, TTabList, TTab, TTabPanel, TSpinner, TAlert,
  TCard, TTag, TEmptyState, TGrid, TStat, TProgress, TDivider, useToast,
} from '@treeui/vue';
import { api } from '../../services/api';
import type { QueueSnapshot } from '../../services/api';
import QueueSendReceivePanel from './QueueSendReceivePanel.vue';

const props = defineProps<{ queueName: string }>();
const emit = defineEmits<{ (e: 'back'): void }>();

const route = useRoute();
const router = useRouter();
const toast = useToast();

const queue = ref<QueueSnapshot | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
let refreshTimer: number | null = null;

const VALID_TABS = ['send-receive', 'consumers', 'attributes'] as const;
type TabValue = typeof VALID_TABS[number];

const activeTab = computed<TabValue>({
  get() {
    const q = String(route.query.tab || '');
    return (VALID_TABS as readonly string[]).includes(q) ? (q as TabValue) : 'send-receive';
  },
  set(value) {
    router.replace({
      query: { ...route.query, tab: value === 'send-receive' ? undefined : value },
    });
  },
});

const depthRatio = computed(() => {
  const q = queue.value;
  if (!q) return 0;
  const all = q.available + q.inFlight + q.processed;
  if (!all) return 0;
  return Math.round((q.processed / all) * 100);
});

async function load(showSpinner = true) {
  if (showSpinner) loading.value = true;
  try {
    queue.value = await api.getQueue(props.queueName);
    error.value = null;
  } catch (err: any) {
    error.value = err.message || 'Failed to load queue';
    queue.value = null;
  } finally {
    loading.value = false;
  }
}

async function resetProcessed() {
  if (!queue.value) return;
  try {
    await api.resetQueueProcessed(queue.value.name);
    toast.add({ title: 'Processed counter reset', variant: 'info' });
    await load(false);
  } catch (err: any) {
    toast.add({
      title: 'Failed to reset counter',
      description: err.message,
      variant: 'danger',
    });
  }
}

function formatSeconds(value?: number): string {
  if (value === undefined) return '—';
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.round(value / 60)}m`;
  if (value < 86400) return `${Math.round(value / 3600)}h`;
  return `${Math.round(value / 86400)}d`;
}

function formatDate(ts?: number): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

onMounted(() => {
  load();
  refreshTimer = window.setInterval(() => load(false), 4000);
});

onBeforeUnmount(() => {
  if (refreshTimer) window.clearInterval(refreshTimer);
});

watch(() => props.queueName, () => load());
</script>

<template>
  <TStack direction="vertical" gap="1rem">
    <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
      <TStack direction="horizontal" gap="0.5rem" align="center">
        <TButton size="sm" variant="ghost" @click="emit('back')">← Queues</TButton>
        <strong style="font-size: 1.1rem;">{{ queueName }}</strong>
        <TBadge v-if="queue?.fifo" tone="info" variant="soft">FIFO</TBadge>
      </TStack>
      <TButton size="sm" variant="ghost" :loading="loading" @click="load()">Refresh</TButton>
    </TStack>

    <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
      {{ error }}
    </TAlert>

    <div v-if="loading && !queue" style="display: flex; justify-content: center; padding: 2rem;">
      <TSpinner label="Loading queue..." />
    </div>

    <template v-else-if="queue">
      <TGrid :columns="4" gap="0.75rem">
        <TStat label="Available" :value="queue.available" tone="warning" />
        <TStat label="In flight" :value="queue.inFlight" tone="info" />
        <TStat label="Delayed" :value="queue.delayed" tone="neutral" />
        <TStat label="Processed (session)" :value="queue.processed" tone="success" />
      </TGrid>

      <TTabs v-model="activeTab">
        <TTabList>
          <TTab value="send-receive">Send &amp; receive</TTab>
          <TTab value="consumers">Consumers</TTab>
          <TTab value="attributes">Attributes</TTab>
        </TTabList>

        <TTabPanel value="send-receive">
          <div style="padding-top: 1rem;">
            <QueueSendReceivePanel :queue="queue" @refresh="load(false)" />
          </div>
        </TTabPanel>

        <TTabPanel value="consumers">
          <div style="padding-top: 1rem;">
            <TCard variant="outline">
              <template #header>
                <strong>Lambda event-source mappings</strong>
              </template>
              <TStack
                v-if="queue.consumers.length"
                direction="vertical"
                gap="0.5rem"
              >
                <TCard
                  v-for="c in queue.consumers"
                  :key="c.uuid || c.functionName"
                  variant="soft"
                >
                  <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
                    <TStack direction="vertical" gap="0.125rem">
                      <span class="mono">{{ c.functionName }}</span>
                      <span class="muted" style="font-size: 0.75rem;">
                        UUID: {{ c.uuid || '—' }} · batch size {{ c.batchSize ?? '—' }}
                      </span>
                    </TStack>
                    <TBadge :tone="c.enabled ? 'success' : 'neutral'" variant="soft">
                      {{ c.state || (c.enabled ? 'Enabled' : 'Disabled') }}
                    </TBadge>
                  </TStack>
                </TCard>
              </TStack>
              <TEmptyState
                v-else
                title="No consumers attached"
                description="No Lambda event-source mapping currently points at this queue."
              />
            </TCard>
          </div>
        </TTabPanel>

        <TTabPanel value="attributes">
          <div style="padding-top: 1rem;">
            <TStack direction="vertical" gap="1rem">
              <TCard variant="outline">
                <template #header>
                  <strong>Identity</strong>
                </template>
                <TStack direction="vertical" gap="0.5rem">
                  <TStack direction="horizontal" justify="space-between" wrap gap="0.5rem">
                    <span class="muted">Queue URL</span>
                    <span class="mono" style="font-size: 0.78rem;">{{ queue.url }}</span>
                  </TStack>
                  <TStack direction="horizontal" justify="space-between" wrap gap="0.5rem">
                    <span class="muted">ARN</span>
                    <span class="mono" style="font-size: 0.78rem;">{{ queue.arn || '—' }}</span>
                  </TStack>
                </TStack>
              </TCard>

              <TCard variant="outline">
                <template #header>
                  <strong>Configuration</strong>
                </template>
                <TStack direction="horizontal" gap="0.5rem" wrap>
                  <TTag size="sm" variant="soft">
                    FIFO: {{ queue.fifo ? 'yes' : 'no' }}
                  </TTag>
                  <TTag size="sm" variant="soft">
                    Visibility timeout: {{ formatSeconds(queue.visibilityTimeout) }}
                  </TTag>
                  <TTag size="sm" variant="soft">
                    Retention: {{ formatSeconds(queue.messageRetentionPeriod) }}
                  </TTag>
                  <TTag size="sm" variant="soft">
                    Delayed: {{ queue.delayed }}
                  </TTag>
                </TStack>
                <template #footer>
                  <span class="muted" style="font-size: 0.75rem;">
                    Created {{ formatDate(queue.createdAt) }} · last polled
                    {{ formatDate(queue.lastPolledAt) }}
                  </span>
                </template>
              </TCard>

              <TCard variant="outline">
                <template #header>
                  <strong>Throughput</strong>
                </template>
                <TStack direction="vertical" gap="0.5rem">
                  <TStack direction="horizontal" justify="space-between" align="center">
                    <span class="muted">Processed share (this session)</span>
                    <span class="mono">{{ depthRatio }}%</span>
                  </TStack>
                  <TProgress :value="depthRatio" />
                </TStack>
                <template #footer>
                  <TStack direction="horizontal" justify="flex-end">
                    <TButton size="sm" variant="ghost" @click="resetProcessed">
                      Reset processed counter
                    </TButton>
                  </TStack>
                </template>
              </TCard>
            </TStack>
          </div>
        </TTabPanel>
      </TTabs>
    </template>
  </TStack>
</template>
