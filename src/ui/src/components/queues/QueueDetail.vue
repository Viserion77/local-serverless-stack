<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  TButton, TBadge, TStack, TTabs, TTabList, TTab, TTabPanel, TSpinner, TAlert,
  TCard, TTag, TEmptyState, TGrid, TStat, TProgress,
  TText, TIcon, TDescriptionList, TDescriptionItem, useToast,
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
        <TButton size="sm" variant="ghost" @click="emit('back')"><TIcon name="arrow-left" /> Queues</TButton>
        <TText weight="semibold" size="lg">{{ queueName }}</TText>
        <TBadge v-if="queue?.fifo" tone="info" variant="soft">FIFO</TBadge>
      </TStack>
      <TButton size="sm" variant="ghost" :loading="loading" @click="load()">Refresh</TButton>
    </TStack>

    <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
      {{ error }}
    </TAlert>

    <TStack v-if="loading && !queue" direction="horizontal" justify="center" align="center">
      <TSpinner label="Loading queue..." />
    </TStack>

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
                <TText weight="semibold">Lambda event-source mappings</TText>
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
                      <TText family="mono">{{ c.functionName }}</TText>
                      <TText tone="muted" size="xs">
                        UUID: {{ c.uuid || '—' }} · batch size {{ c.batchSize ?? '—' }}
                      </TText>
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
                  <TText weight="semibold">Identity</TText>
                </template>
                <TDescriptionList>
                  <TDescriptionItem label="Queue URL">
                    <TText family="mono" size="sm">{{ queue.url }}</TText>
                  </TDescriptionItem>
                  <TDescriptionItem label="ARN">
                    <TText family="mono" size="sm">{{ queue.arn || '—' }}</TText>
                  </TDescriptionItem>
                </TDescriptionList>
              </TCard>

              <TCard variant="outline">
                <template #header>
                  <TText weight="semibold">Configuration</TText>
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
                  <TText tone="muted" size="xs">
                    Created {{ formatDate(queue.createdAt) }} · last polled
                    {{ formatDate(queue.lastPolledAt) }}
                  </TText>
                </template>
              </TCard>

              <TCard variant="outline">
                <template #header>
                  <TText weight="semibold">Throughput</TText>
                </template>
                <TStack direction="vertical" gap="0.5rem">
                  <TDescriptionList>
                    <TDescriptionItem label="Processed share (this session)">
                      <TText family="mono">{{ depthRatio }}%</TText>
                    </TDescriptionItem>
                  </TDescriptionList>
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
