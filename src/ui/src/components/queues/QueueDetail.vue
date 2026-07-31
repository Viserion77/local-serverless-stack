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
import { useI18n } from '../../i18n';

const { t } = useI18n();
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
    error.value = err.message || t('queues.loadDetailError');
    queue.value = null;
  } finally {
    loading.value = false;
  }
}

async function resetProcessed() {
  if (!queue.value) return;
  try {
    await api.resetQueueProcessed(queue.value.name);
    toast.add({ title: t('queues.processedCounterReset'), variant: 'info' });
    await load(false);
  } catch (err: any) {
    toast.add({
      title: t('queues.resetCounterFailed'),
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
        <TButton size="sm" variant="ghost" @click="emit('back')">
          <TIcon name="arrow-left" /> {{ t('queues.backToQueues') }}
        </TButton>
        <TText weight="semibold" size="lg">{{ queueName }}</TText>
        <TBadge v-if="queue?.fifo" tone="info" variant="soft">FIFO</TBadge>
      </TStack>
      <TButton size="sm" variant="ghost" :loading="loading" @click="load()">
        {{ t('common.refresh') }}
      </TButton>
    </TStack>

    <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
      {{ error }}
    </TAlert>

    <TStack v-if="loading && !queue" direction="horizontal" justify="center" align="center">
      <TSpinner :label="t('queues.loadingDetail')" />
    </TStack>

    <template v-else-if="queue">
      <TGrid :columns="4" gap="0.75rem">
        <TStat :label="t('queues.colAvailable')" :value="queue.available" tone="warning" />
        <TStat :label="t('queues.colInFlight')" :value="queue.inFlight" tone="info" />
        <TStat :label="t('queues.statDelayed')" :value="queue.delayed" tone="neutral" />
        <TStat :label="t('queues.statProcessedSession')" :value="queue.processed" tone="success" />
      </TGrid>

      <TTabs v-model="activeTab">
        <TTabList>
          <TTab value="send-receive">{{ t('queues.tabSendReceive') }}</TTab>
          <TTab value="consumers">{{ t('queues.tabConsumers') }}</TTab>
          <TTab value="attributes">{{ t('queues.tabAttributes') }}</TTab>
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
                <TText weight="semibold">{{ t('queues.eventSourceMappings') }}</TText>
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
                        {{ t('queues.consumerMeta', {
                          uuid: c.uuid || '—',
                          batchSize: c.batchSize ?? '—',
                        }) }}
                      </TText>
                    </TStack>
                    <TBadge :tone="c.enabled ? 'success' : 'neutral'" variant="soft">
                      {{ c.state || (c.enabled ? t('queues.enabled') : t('queues.disabled')) }}
                    </TBadge>
                  </TStack>
                </TCard>
              </TStack>
              <TEmptyState
                v-else
                :title="t('queues.noConsumersTitle')"
                :description="t('queues.noConsumersDescription')"
              />
            </TCard>
          </div>
        </TTabPanel>

        <TTabPanel value="attributes">
          <div style="padding-top: 1rem;">
            <TStack direction="vertical" gap="1rem">
              <TCard variant="outline">
                <template #header>
                  <TText weight="semibold">{{ t('queues.identity') }}</TText>
                </template>
                <TDescriptionList>
                  <TDescriptionItem :label="t('queues.queueUrl')">
                    <TText family="mono" size="sm">{{ queue.url }}</TText>
                  </TDescriptionItem>
                  <TDescriptionItem label="ARN">
                    <TText family="mono" size="sm">{{ queue.arn || '—' }}</TText>
                  </TDescriptionItem>
                </TDescriptionList>
              </TCard>

              <TCard variant="outline">
                <template #header>
                  <TText weight="semibold">{{ t('queues.configuration') }}</TText>
                </template>
                <TStack direction="horizontal" gap="0.5rem" wrap>
                  <TTag size="sm" variant="soft">
                    FIFO: {{ queue.fifo ? t('common.yes') : t('common.no') }}
                  </TTag>
                  <TTag size="sm" variant="soft">
                    {{ t('queues.visibilityTimeout') }}: {{ formatSeconds(queue.visibilityTimeout) }}
                  </TTag>
                  <TTag size="sm" variant="soft">
                    {{ t('queues.retention') }}: {{ formatSeconds(queue.messageRetentionPeriod) }}
                  </TTag>
                  <TTag size="sm" variant="soft">
                    {{ t('queues.delayed') }}: {{ queue.delayed }}
                  </TTag>
                </TStack>
                <template #footer>
                  <TText tone="muted" size="xs">
                    {{ t('queues.createdPolled', {
                      created: formatDate(queue.createdAt),
                      polled: formatDate(queue.lastPolledAt),
                    }) }}
                  </TText>
                </template>
              </TCard>

              <TCard variant="outline">
                <template #header>
                  <TText weight="semibold">{{ t('queues.throughput') }}</TText>
                </template>
                <TStack direction="vertical" gap="0.5rem">
                  <TDescriptionList>
                    <TDescriptionItem :label="t('queues.processedShare')">
                      <TText family="mono">{{ depthRatio }}%</TText>
                    </TDescriptionItem>
                  </TDescriptionList>
                  <TProgress :value="depthRatio" />
                </TStack>
                <template #footer>
                  <TStack direction="horizontal" justify="flex-end">
                    <TButton size="sm" variant="ghost" @click="resetProcessed">
                      {{ t('queues.resetProcessed') }}
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
