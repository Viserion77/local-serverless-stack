<script setup lang="ts">
import { ref, computed } from 'vue';
import {
  TCard, TButton, TStack, TStackItem, TInput, TTextarea, TFormField, TAlert, TBadge,
  TDivider, TTable, TEmptyState, TSpinner, TConfirmDialog, TSelect,
  TText, TIcon, TLink, TCodeBlock, useToast,
} from '@treeui/vue';
import { api } from '../../services/api';
import type {
  QueueSnapshot, SqsMessage, SqsMessageAttributeInput,
} from '../../services/api';
import { useI18n } from '../../i18n';

const { t } = useI18n();
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

// TTable's `expandedRow` holds ONE key, matched against `rowKey` — so the
// detail is a single-open disclosure now. The old `Record<string, boolean>`
// could hold several open at once, and every one of them stacked below the
// whole table instead of next to its row; the `detail` slot is what fixes that,
// and one-at-a-time is the price of the shape.
const expandedRow = ref<string | null>(null);

const attrTypeOptions = [
  { value: 'String', label: 'String' },
  { value: 'Number', label: 'Number' },
  { value: 'Binary', label: 'Binary' },
];

const isFifo = computed(() => props.queue.fifo);

// Computed so the headers follow a language switch — `t()` is only reactive
// when it runs inside a render/computed, never hoisted to a module const.
const messagesColumns = computed(() => [
  { key: 'preview', label: t('queues.colBodyPreview') },
  { key: 'messageId', label: t('queues.colMessageId') },
  { key: 'sentAt', label: t('queues.colSentAt') },
  { key: 'attrs', label: t('queues.colAttrs'), align: 'right' as const },
  { key: 'actions', label: '', align: 'right' as const },
]);

const messagesRows = computed(() =>
  messages.value.map((m, idx) => ({
    __id: idx,
    // Row identity for `rowKey`/`expandedRow`. SQS always sends a messageId,
    // but the contract types it optional — the index is the fallback so two
    // id-less messages never collapse onto the same key (and onto the same
    // expanded detail).
    __key: m.messageId || `row-${idx}`,
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

function toggleExpanded(key: string) {
  expandedRow.value = expandedRow.value === key ? null : key;
}

async function send() {
  if (!body.value.trim()) {
    sendError.value = t('queues.bodyRequired');
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
      title: t('queues.messageSent'),
      description: result.messageId,
      variant: 'success',
    });
    emit('refresh');
  } catch (err: any) {
    sendError.value = err.message || t('queues.sendFailed');
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
    // A new result set is a new set of rows: an expanded key left over from the
    // previous poll would re-open a detail the user never asked for if the same
    // message came back.
    expandedRow.value = null;
    if (!res.messages.length) {
      toast.add({
        title: t('queues.noMessagesAvailable'),
        description: t('queues.noMessagesAvailableDescription'),
        variant: 'info',
      });
    }
    emit('refresh');
  } catch (err: any) {
    pollError.value = err.message || t('queues.pollFailed');
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
    if (expandedRow.value === m.messageId) expandedRow.value = null;
    toast.add({ title: t('queues.messageDeleted'), variant: 'success' });
    emit('refresh');
  } catch (err: any) {
    toast.add({
      title: t('queues.deleteFailed'),
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
      title: t('queues.queuePurged'),
      description: t('queues.queuePurgedDescription'),
      variant: 'warning',
    });
    emit('refresh');
  } catch (err: any) {
    toast.add({
      title: t('queues.purgeFailed'),
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
    toast.add({ title: t('queues.copiedToClipboard'), variant: 'info' });
  });
}
</script>

<template>
  <TStack direction="vertical" gap="1rem">
    <TCard variant="outline">
      <template #header>
        <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
          <TText weight="semibold">{{ t('queues.sendMessageTitle') }}</TText>
          <TBadge v-if="isFifo" tone="info" variant="soft">FIFO</TBadge>
        </TStack>
      </template>

      <TStack direction="vertical" gap="0.75rem">
        <TFormField :label="t('queues.messageBody')" :hint="t('queues.messageBodyHint')">
          <TTextarea
            v-model="body"
            :rows="6"
            placeholder='{"event": "order.created", "orderId": "abc-123"}'
          />
        </TFormField>

        <!-- TFormField has no flex axis of its own, so the share of the row
             lives on TStackItem. `basis="0"` is not optional: TStackItem
             defaults to `auto`, and only `grow` + `basis: 0` reproduces the
             `flex: N` shorthand these fields used to carry inline. -->
        <TStack direction="horizontal" gap="1rem">
          <TStackItem v-if="!isFifo" :grow="1" basis="0">
            <TFormField :label="t('queues.delayLabel')" hint="0–900">
              <TInput v-model.number="delaySeconds" type="number" min="0" max="900" />
            </TFormField>
          </TStackItem>
          <TStackItem v-if="isFifo" :grow="1" basis="0">
            <TFormField label="MessageGroupId" :hint="t('queues.groupIdHint')">
              <TInput v-model="messageGroupId" placeholder="default" />
            </TFormField>
          </TStackItem>
          <TStackItem v-if="isFifo" :grow="1" basis="0">
            <TFormField label="MessageDeduplicationId" :hint="t('queues.dedupIdHint')">
              <TInput v-model="messageDeduplicationId" placeholder="auto" />
            </TFormField>
          </TStackItem>
        </TStack>

        <TStack direction="vertical" gap="0.5rem">
          <TStack direction="horizontal" justify="space-between" align="center">
            <TText weight="semibold" size="sm">{{ t('queues.messageAttributesOptional') }}</TText>
            <TButton size="sm" variant="outline" @click="addAttr">
              {{ t('queues.addAttribute') }}
            </TButton>
          </TStack>
          <TStack
            v-for="(a, i) in attrs"
            :key="`a-${i}`"
            direction="horizontal"
            gap="0.5rem"
            align="end"
          >
            <TStackItem :grow="1.4" basis="0">
              <TFormField :label="t('common.name')">
                <TInput v-model="a.name" placeholder="contentType" />
              </TFormField>
            </TStackItem>
            <TStackItem :grow="0.9" basis="0">
              <TFormField :label="t('common.type')">
                <TSelect v-model="a.type" :options="attrTypeOptions" />
              </TFormField>
            </TStackItem>
            <TStackItem :grow="2" basis="0">
              <TFormField :label="t('queues.value')">
                <TInput v-model="a.value" placeholder="application/json" />
              </TFormField>
            </TStackItem>
            <TButton size="sm" variant="outline" @click="removeAttr(i)">
              {{ t('queues.remove') }}
            </TButton>
          </TStack>
        </TStack>
      </TStack>

      <template #footer>
        <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
          <TStack direction="horizontal" gap="0.5rem" align="center">
            <TButton variant="solid" :loading="sending" @click="send">
              {{ t('queues.sendMessage') }}
            </TButton>
            <TButton variant="ghost" :disabled="sending" @click="body = ''">
              {{ t('queues.clear') }}
            </TButton>
          </TStack>
          <TText v-if="lastSent" tone="muted" family="mono" size="xs">
            {{ t('queues.lastSent') }} {{ lastSent.messageId }}
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
          <TText weight="semibold">{{ t('queues.pollTitle') }}</TText>
          <TBadge tone="warning" variant="soft">
            {{ t('queues.visibilityNotice') }}
          </TBadge>
        </TStack>
      </template>

      <TStack direction="horizontal" gap="1rem">
        <TStackItem :grow="1" basis="0">
          <TFormField :label="t('queues.maxMessages')" hint="1–10">
            <TInput v-model.number="maxMessages" type="number" min="1" max="10" />
          </TFormField>
        </TStackItem>
        <TStackItem :grow="1" basis="0">
          <TFormField
            :label="t('queues.visibilityTimeoutSeconds')"
            :hint="t('queues.visibilityTimeoutHint')"
          >
            <TInput v-model.number="visibilityTimeout" type="number" min="0" />
          </TFormField>
        </TStackItem>
        <TStackItem :grow="1" basis="0">
          <TFormField :label="t('queues.waitTime')" :hint="t('queues.waitTimeHint')">
            <TInput v-model.number="waitTimeSeconds" type="number" min="0" max="20" />
          </TFormField>
        </TStackItem>
      </TStack>

      <template #footer>
        <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
          <TStack direction="horizontal" gap="0.5rem">
            <TButton variant="solid" :loading="polling" @click="poll">
              {{ t('queues.pollMessages') }}
            </TButton>
            <TButton variant="ghost" :disabled="!messages.length" @click="messages = []">
              {{ t('queues.clearResults') }}
            </TButton>
          </TStack>
          <!-- `variant="danger"` is deprecated since 0.29: colour was trapped in
               the shape scale, so it could only ever be a filled red button.
               `tone` is the orthogonal colour axis now, and it IS a TButton prop
               — it was not when this was first written, which is why the intent
               went to the DOM node and never rendered. -->
          <TButton size="sm" variant="solid" tone="danger" @click="confirmPurgeOpen = true">
            {{ t('queues.purgeQueue') }}
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
          <TText weight="semibold">
            {{ t('queues.receivedMessages', { count: messages.length }) }}
          </TText>
          <TText tone="muted" size="xs">
            {{ t('queues.clickRowHint') }}
          </TText>
        </TStack>
      </template>

      <TStack v-if="polling && !messages.length" direction="horizontal" justify="center" align="center">
        <TSpinner :label="t('queues.polling')" />
      </TStack>

      <TEmptyState
        v-else-if="!messages.length"
        :title="t('queues.noMessagesLoaded')"
        :description="t('queues.noMessagesLoadedDescription')"
      />

      <!-- The row stays a plain `row`: this is a disclosure, not an activation.
           `rowActivatable` would announce "button" on something that expands in
           place, and the actions column already holds the real Copy/Delete
           controls.
           Since 0.30 TTable no longer stamps `aria-expanded`/`aria-controls` on
           every `<tr>` that has a `detail` slot — it announced rows that never
           expand and pointed at an id the consumer could not reach. The cell
           slot now hands out `expanded` and `detailId`, so the control that
           actually toggles carries both, which is where the norm wants them. -->
      <TTable
        v-else
        :columns="messagesColumns"
        :rows="messagesRows"
        row-key="__key"
        :expanded-row="expandedRow"
        :aria-label="t('queues.receivedMessagesAria')"
      >
        <!-- The row toggle is a disclosure, so it announces `aria-expanded`.
             It stays an anchor rather than becoming a TButton: `.t-button` is
             `min-width: max-content` with a fixed control height, which an
             80-character body preview would stretch into a column no viewport
             can hold. TLink drops the hand-written `text-decoration:none`;
             the missing piece — a text-level disclosure control that wraps —
             is a TreeUI gap, not something to patch with local CSS. -->
        <template #cell-preview="{ row, expanded, detailId }">
          <TLink
            href="#"
            underline="none"
            :aria-expanded="expanded ? 'true' : 'false'"
            :aria-controls="detailId"
            @click.prevent="toggleExpanded(String((row as any).__key))"
          >
            <TText family="mono" size="sm">
              <TIcon :name="expanded ? 'chevron-down' : 'chevron-right'" />
              {{ (row as any).preview }}
            </TText>
          </TLink>
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
              {{ t('common.copy') }}
            </TButton>
            <TButton
              size="sm"
              variant="solid"
              tone="danger"
              :loading="deleting[String((row as any).messageId)]"
              @click="deleteOne((row as any).__raw)"
            >
              {{ t('common.delete') }}
            </TButton>
          </TStack>
        </template>

        <!-- The detail is a `<tr>` adjacent to its own row now, wired to it by
             `aria-controls`. It used to be a v-for AFTER `</TTable>`, so every
             expanded body stacked below the whole table, detached from the row
             that produced it. No TCard around it either: the detail cell already
             carries the recessed surface and its padding. -->
        <template #detail="{ row }">
          <TStack direction="vertical" gap="0.5rem">
            <TStack direction="horizontal" gap="0.5rem" wrap>
              <TBadge tone="neutral" variant="soft">id: {{ (row as any).__raw.messageId }}</TBadge>
              <TBadge v-if="(row as any).__raw.md5OfBody" tone="neutral" variant="soft">
                md5: {{ (row as any).__raw.md5OfBody.slice(0, 12) }}…
              </TBadge>
              <TBadge
                v-for="(v, k) in (row as any).__raw.attributes || {}"
                :key="k"
                tone="info"
                variant="soft"
              >
                {{ k }}: {{ v }}
              </TBadge>
            </TStack>

            <TStack
              v-if="(row as any).__raw.messageAttributes && Object.keys((row as any).__raw.messageAttributes).length"
              direction="vertical"
              gap="0.375rem"
            >
              <TText weight="semibold" size="sm">{{ t('queues.messageAttributes') }}</TText>
              <TStack direction="horizontal" gap="0.375rem" wrap>
                <TBadge
                  v-for="(v, k) in (row as any).__raw.messageAttributes"
                  :key="`ma-${k}`"
                  tone="success"
                  variant="soft"
                >
                  {{ k }} ({{ (v as any).type || 'String' }}): {{ (v as any).value }}
                </TBadge>
              </TStack>
            </TStack>

            <TDivider />
            <TCodeBlock
              :code="formatJsonIfPossible((row as any).__raw.body)"
              :label="t('queues.messageBody')"
              max-block-size="24rem"
              wrap
              copyable
            />
          </TStack>
        </template>
      </TTable>
    </TCard>

    <TConfirmDialog
      v-model:open="confirmPurgeOpen"
      :title="t('queues.purgeQueue')"
      :description="t('queues.purgeConfirmDescription', { queue: props.queue.name })"
      :confirm-label="t('queues.purgeConfirmLabel')"
      :cancel-label="t('common.cancel')"
      :loading="purging"
      @confirm="doPurge"
    />
  </TStack>
</template>
