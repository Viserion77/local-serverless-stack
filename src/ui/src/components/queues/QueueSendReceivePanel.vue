<script setup lang="ts">
import { ref, computed } from 'vue';
import {
  TCard, TButton, TStack, TInput, TTextarea, TFormField, TAlert, TBadge,
  TDivider, TTable, TEmptyState, TSpinner, TConfirmDialog, TSelect,
  TText, TIcon, TCodeBlock, useToast,
} from '@treeui/vue';
import { api } from '../../services/api';
import type {
  QueueSnapshot, SqsMessage, SqsMessageAttributeInput,
} from '../../services/api';

const props = defineProps<{ queue: QueueSnapshot }>();
const emit = defineEmits<{ (e: 'refresh'): void }>();

const toast = useToast();

const body = ref<string>('');
const delaySeconds = ref<number>(0);
const messageGroupId = ref<string>('default');
const messageDeduplicationId = ref<string>('');
const attrs = ref<SqsMessageAttributeInput[]>([]);
const sending = ref(false);
const sendError = ref<string | null>(null);
const lastSent = ref<{ messageId?: string; sequenceNumber?: string } | null>(null);

const maxMessages = ref<number>(10);
const waitTimeSeconds = ref<number>(0);
const visibilityTimeout = ref<number>(0);
const messages = ref<SqsMessage[]>([]);
const polling = ref(false);
const pollError = ref<string | null>(null);

const deleting = ref<Record<string, boolean>>({});
const confirmPurgeOpen = ref(false);
const purging = ref(false);
const expanded = ref<Record<string, boolean>>({});

const attrTypeOptions = [
  { value: 'String', label: 'String' },
  { value: 'Number', label: 'Number' },
  { value: 'Binary', label: 'Binary' },
];

const isFifo = computed(() => props.queue.fifo);

const messagesColumns = [
  { key: 'preview', label: 'Body preview' },
  { key: 'messageId', label: 'Message ID' },
  { key: 'sentAt', label: 'Sent at' },
  { key: 'attrs', label: 'Attrs', align: 'right' as const },
  { key: 'actions', label: '', align: 'right' as const },
];

const messagesRows = computed(() =>
  messages.value.map((m, idx) => ({
    __id: idx,
    __raw: m,
    messageId: m.messageId || '—',
    preview: previewBody(m.body),
    sentAt: formatSentAt(m.attributes?.SentTimestamp),
    attrs: m.messageAttributes ? Object.keys(m.messageAttributes).length : 0,
  })),
);

function previewBody(text?: string): string {
  if (!text) return '—';
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 80 ? `${t.slice(0, 80)}…` : t;
}

function formatSentAt(ts?: string): string {
  if (!ts) return '—';
  const n = Number(ts);
  if (!n) return '—';
  return new Date(n).toLocaleString();
}

function addAttr() {
  attrs.value.push({ name: '', type: 'String', value: '' });
}

function removeAttr(i: number) {
  attrs.value.splice(i, 1);
}

function formatJsonIfPossible(text?: string): string {
  if (!text) return '';
  const trimmed = text.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

function toggleExpanded(id: string) {
  expanded.value[id] = !expanded.value[id];
}

async function send() {
  if (!body.value.trim()) {
    sendError.value = 'Message body is required';
    return;
  }
  sending.value = true;
  sendError.value = null;
  try {
    const cleanAttrs = attrs.value.filter(a => a.name.trim());
    const result = await api.sendQueueMessage(props.queue.name, {
      body: body.value,
      delaySeconds: isFifo.value ? undefined : delaySeconds.value || undefined,
      messageAttributes: cleanAttrs.length ? cleanAttrs : undefined,
      messageGroupId: isFifo.value ? messageGroupId.value || 'default' : undefined,
      messageDeduplicationId:
        isFifo.value && messageDeduplicationId.value ? messageDeduplicationId.value : undefined,
    });
    lastSent.value = { messageId: result.messageId, sequenceNumber: result.sequenceNumber };
    toast.add({
      title: 'Message sent',
      description: result.messageId,
      variant: 'success',
    });
    emit('refresh');
  } catch (err: any) {
    sendError.value = err.message || 'Failed to send message';
  } finally {
    sending.value = false;
  }
}

async function poll() {
  polling.value = true;
  pollError.value = null;
  try {
    const res = await api.receiveQueueMessages(props.queue.name, {
      maxNumberOfMessages: maxMessages.value,
      visibilityTimeout: visibilityTimeout.value,
      waitTimeSeconds: waitTimeSeconds.value,
    });
    messages.value = res.messages;
    if (!res.messages.length) {
      toast.add({
        title: 'No messages available',
        description: 'The queue returned an empty batch.',
        variant: 'info',
      });
    }
    emit('refresh');
  } catch (err: any) {
    pollError.value = err.message || 'Failed to poll messages';
  } finally {
    polling.value = false;
  }
}

async function deleteOne(m: SqsMessage) {
  if (!m.receiptHandle || !m.messageId) return;
  deleting.value[m.messageId] = true;
  try {
    await api.deleteQueueMessage(props.queue.name, m.receiptHandle);
    messages.value = messages.value.filter(x => x.messageId !== m.messageId);
    toast.add({ title: 'Message deleted', variant: 'success' });
    emit('refresh');
  } catch (err: any) {
    toast.add({
      title: 'Failed to delete message',
      description: err.message,
      variant: 'danger',
    });
  } finally {
    delete deleting.value[m.messageId];
  }
}

async function doPurge() {
  purging.value = true;
  try {
    await api.purgeQueue(props.queue.name);
    messages.value = [];
    toast.add({
      title: 'Queue purged',
      description: 'All messages were removed. It can take up to 60s to fully clear.',
      variant: 'warning',
    });
    emit('refresh');
  } catch (err: any) {
    toast.add({
      title: 'Failed to purge queue',
      description: err.message,
      variant: 'danger',
    });
  } finally {
    purging.value = false;
    confirmPurgeOpen.value = false;
  }
}

function copyToClipboard(text: string) {
  navigator.clipboard?.writeText(text).then(() => {
    toast.add({ title: 'Copied to clipboard', variant: 'info' });
  });
}
</script>

<template>
  <TStack direction="vertical" gap="1rem">
    <TCard variant="outline">
      <template #header>
        <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
          <TText weight="semibold">Send a message</TText>
          <TBadge v-if="isFifo" tone="info" variant="soft">FIFO</TBadge>
        </TStack>
      </template>

      <TStack direction="vertical" gap="0.75rem">
        <TFormField label="Message body" hint="Plain text or JSON">
          <TTextarea
            v-model="body"
            :rows="6"
            placeholder='{"event": "order.created", "orderId": "abc-123"}'
          />
        </TFormField>

        <TStack direction="horizontal" gap="1rem">
          <TFormField
            v-if="!isFifo"
            label="Delay (seconds)"
            hint="0–900"
            style="flex: 1;"
          >
            <TInput v-model.number="delaySeconds" type="number" min="0" max="900" />
          </TFormField>
          <TFormField
            v-if="isFifo"
            label="MessageGroupId"
            hint="Required for FIFO. Defaults to 'default'."
            style="flex: 1;"
          >
            <TInput v-model="messageGroupId" placeholder="default" />
          </TFormField>
          <TFormField
            v-if="isFifo"
            label="MessageDeduplicationId"
            hint="Optional if content-based dedup is on"
            style="flex: 1;"
          >
            <TInput v-model="messageDeduplicationId" placeholder="auto" />
          </TFormField>
        </TStack>

        <TStack direction="vertical" gap="0.5rem">
          <TStack direction="horizontal" justify="space-between" align="center">
            <TText weight="semibold" size="sm">Message attributes – optional</TText>
            <TButton size="sm" variant="outline" @click="addAttr">Add attribute</TButton>
          </TStack>
          <TStack
            v-for="(a, i) in attrs"
            :key="`a-${i}`"
            direction="horizontal"
            gap="0.5rem"
            align="end"
          >
            <TFormField label="Name" style="flex: 1.4;">
              <TInput v-model="a.name" placeholder="contentType" />
            </TFormField>
            <TFormField label="Type" style="flex: 0.9;">
              <TSelect v-model="a.type" :options="attrTypeOptions" />
            </TFormField>
            <TFormField label="Value" style="flex: 2;">
              <TInput v-model="a.value" placeholder="application/json" />
            </TFormField>
            <TButton size="sm" variant="outline" @click="removeAttr(i)">Remove</TButton>
          </TStack>
        </TStack>
      </TStack>

      <template #footer>
        <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
          <TStack direction="horizontal" gap="0.5rem" align="center">
            <TButton variant="solid" :loading="sending" @click="send">Send message</TButton>
            <TButton variant="ghost" :disabled="sending" @click="body = ''">Clear</TButton>
          </TStack>
          <TText v-if="lastSent" tone="muted" family="mono" size="xs">
            Last sent: {{ lastSent.messageId }}
            <template v-if="lastSent.sequenceNumber">
              · seq {{ lastSent.sequenceNumber }}
            </template>
          </TText>
        </TStack>
      </template>
    </TCard>

    <TAlert v-if="sendError" variant="danger" dismissible @dismiss="sendError = null">
      {{ sendError }}
    </TAlert>

    <TCard variant="outline">
      <template #header>
        <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
          <TText weight="semibold">Poll for messages</TText>
          <TBadge tone="warning" variant="soft">
            Messages become invisible during the visibility timeout
          </TBadge>
        </TStack>
      </template>

      <TStack direction="horizontal" gap="1rem">
        <TFormField label="Max messages" hint="1–10" style="flex: 1;">
          <TInput v-model.number="maxMessages" type="number" min="1" max="10" />
        </TFormField>
        <TFormField
          label="Visibility timeout (s)"
          hint="0 keeps messages visible"
          style="flex: 1;"
        >
          <TInput v-model.number="visibilityTimeout" type="number" min="0" />
        </TFormField>
        <TFormField label="Wait time (s)" hint="0–20 (long polling)" style="flex: 1;">
          <TInput v-model.number="waitTimeSeconds" type="number" min="0" max="20" />
        </TFormField>
      </TStack>

      <template #footer>
        <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
          <TStack direction="horizontal" gap="0.5rem">
            <TButton variant="solid" :loading="polling" @click="poll">Poll messages</TButton>
            <TButton variant="ghost" :disabled="!messages.length" @click="messages = []">
              Clear results
            </TButton>
          </TStack>
          <TButton size="sm" variant="outline" tone="danger" @click="confirmPurgeOpen = true">
            Purge queue
          </TButton>
        </TStack>
      </template>
    </TCard>

    <TAlert v-if="pollError" variant="danger" dismissible @dismiss="pollError = null">
      {{ pollError }}
    </TAlert>

    <TCard variant="outline">
      <template #header>
        <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
          <TText weight="semibold">Received messages ({{ messages.length }})</TText>
          <TText tone="muted" size="xs">
            Click a row to view the full body
          </TText>
        </TStack>
      </template>

      <TStack v-if="polling && !messages.length" direction="horizontal" justify="center" align="center">
        <TSpinner label="Polling..." />
      </TStack>

      <TEmptyState
        v-else-if="!messages.length"
        title="No messages loaded"
        description="Use Poll messages to fetch a batch from the queue."
      />

      <TTable v-else :columns="messagesColumns" :rows="messagesRows" aria-label="Received messages">
        <template #cell-preview="{ row }">
          <a
            href="#"
            style="text-decoration: none;"
            @click.prevent="toggleExpanded(String((row as any).messageId))"
          >
            <TText family="mono" size="sm">
              <TIcon :name="expanded[String((row as any).messageId)] ? 'chevron-down' : 'chevron-right'" />
              {{ (row as any).preview }}
            </TText>
          </a>
        </template>
        <template #cell-messageId="{ row }">
          <TText family="mono" size="xs">{{ (row as any).messageId }}</TText>
        </template>
        <template #cell-sentAt="{ row }">
          <TText tone="muted" size="xs">{{ (row as any).sentAt }}</TText>
        </template>
        <template #cell-attrs="{ row }">
          <TBadge
            v-if="Number((row as any).attrs) > 0"
            tone="info"
            variant="soft"
          >
            {{ (row as any).attrs }}
          </TBadge>
          <TText v-else tone="muted" size="xs">—</TText>
        </template>
        <template #cell-actions="{ row }">
          <TStack direction="horizontal" gap="0.25rem" justify="flex-end">
            <TButton
              size="sm"
              variant="ghost"
              @click="copyToClipboard(String((row as any).__raw.body || ''))"
            >
              Copy
            </TButton>
            <TButton
              size="sm"
              variant="outline"
              tone="danger"
              :loading="deleting[String((row as any).messageId)]"
              @click="deleteOne((row as any).__raw)"
            >
              Delete
            </TButton>
          </TStack>
        </template>
      </TTable>

      <template v-for="m in messages" :key="`detail-${m.messageId}`">
        <div
          v-if="m.messageId && expanded[m.messageId]"
          style="padding: 0.75rem 1rem; border-top: 1px solid var(--tree-color-border, #e5e7eb);"
        >
          <TStack direction="vertical" gap="0.5rem">
            <TStack direction="horizontal" gap="0.5rem" wrap>
              <TBadge tone="neutral" variant="soft">id: {{ m.messageId }}</TBadge>
              <TBadge v-if="m.md5OfBody" tone="neutral" variant="soft">
                md5: {{ m.md5OfBody.slice(0, 12) }}…
              </TBadge>
              <TBadge
                v-for="(v, k) in m.attributes || {}"
                :key="k"
                tone="info"
                variant="soft"
              >
                {{ k }}: {{ v }}
              </TBadge>
            </TStack>

            <div v-if="m.messageAttributes && Object.keys(m.messageAttributes).length">
              <TText weight="semibold" size="sm">Message attributes</TText>
              <TStack direction="horizontal" gap="0.375rem" wrap>
                <TBadge
                  v-for="(v, k) in m.messageAttributes"
                  :key="`ma-${k}`"
                  tone="success"
                  variant="soft"
                >
                  {{ k }} ({{ v.type || 'String' }}): {{ v.value }}
                </TBadge>
              </TStack>
            </div>

            <TDivider />
            <TCodeBlock :code="formatJsonIfPossible(m.body)" label="Message body" max-block-size="24rem" wrap copyable />
          </TStack>
        </div>
      </template>
    </TCard>

    <TConfirmDialog
      v-model:open="confirmPurgeOpen"
      title="Purge queue"
      :description="`Delete every message in '${props.queue.name}'? AWS rate-limits PurgeQueue to once every 60 seconds.`"
      confirm-label="Purge"
      cancel-label="Cancel"
      tone="danger"
      :loading="purging"
      @confirm="doPurge"
    />
  </TStack>
</template>
