<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  TCard, TButton, TStack, TGrid, TStat, TBadge, TSwitch, TInput, TAlert,
  TFormField, TTag, TText, useToast,
} from '@treeui/vue';
import { api } from '../../services/api';
import type { DynamoTableDetail } from '../../services/api';
import { useI18n } from '../../i18n';

const props = defineProps<{ table: DynamoTableDetail }>();
const emit = defineEmits<{ (e: 'refresh'): void }>();

const { t } = useI18n();
const toast = useToast();
const ttlEnabled = ref<boolean>(props.table.ttl.enabled);
const ttlAttribute = ref<string>(props.table.ttl.attributeName || '');
const saving = ref(false);
const error = ref<string | null>(null);

watch(
  () => [props.table.ttl.enabled, props.table.ttl.attributeName] as const,
  ([enabled, attr]) => {
    ttlEnabled.value = enabled;
    ttlAttribute.value = attr || '';
  },
);

async function applyTtl() {
  if (ttlEnabled.value && !ttlAttribute.value.trim()) {
    error.value = t('dynamo.ttlAttrRequired');
    return;
  }
  saving.value = true;
  error.value = null;
  try {
    await api.setDynamoTtl(props.table.name, ttlEnabled.value, ttlAttribute.value.trim() || undefined);
    toast.add({
      title: ttlEnabled.value ? t('dynamo.ttlEnabledToast') : t('dynamo.ttlDisabledToast'),
      description: ttlEnabled.value
        ? t('dynamo.attributeLabel', { name: ttlAttribute.value })
        : undefined,
      variant: 'success',
    });
    emit('refresh');
  } catch (err: any) {
    error.value = err.message || t('dynamo.ttlUpdateFailed');
  } finally {
    saving.value = false;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
</script>

<template>
  <TStack direction="vertical" gap="1rem">
    <TGrid :columns="4" gap="0.75rem">
      <TStat :label="t('dynamo.items')" :value="props.table.itemCount" tone="info" />
      <TStat :label="t('common.size')" :value="formatBytes(props.table.sizeBytes)" tone="neutral" />
      <TStat
        :label="t('common.status')"
        :value="props.table.status || 'UNKNOWN'"
        :tone="props.table.status === 'ACTIVE' ? 'success' : 'warning'"
      />
      <TStat :label="t('dynamo.billing')" :value="props.table.billingMode || '—'" tone="neutral" />
    </TGrid>

    <TCard variant="outline">
      <template #header>
        <TText weight="semibold">Time to Live (TTL)</TText>
      </template>

      <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
        {{ error }}
      </TAlert>

      <TStack direction="vertical" gap="0.75rem">
        <TText tone="muted" size="sm">
          {{ t('dynamo.ttlDescription') }}
        </TText>

        <TFormField :label="t('dynamo.enableTtl')">
          <TSwitch v-model="ttlEnabled" />
        </TFormField>

        <TFormField
          :label="t('dynamo.attributeName')"
          :hint="ttlEnabled ? t('dynamo.ttlHintRequired') : t('dynamo.ttlHintDisabled')"
        >
          <TInput
            v-model="ttlAttribute"
            :placeholder="t('dynamo.ttlAttrPlaceholder')"
            :disabled="!ttlEnabled"
          />
        </TFormField>

        <TStack direction="horizontal" justify="flex-end">
          <TButton size="sm" variant="solid" :loading="saving" @click="applyTtl">
            {{ t('dynamo.apply') }}
          </TButton>
        </TStack>
      </TStack>
    </TCard>

    <TCard variant="outline">
      <template #header>
        <TText weight="semibold">Streams</TText>
      </template>
      <TStack direction="vertical" gap="0.5rem">
        <TStack direction="horizontal" gap="0.5rem" align="center">
          <TBadge :tone="props.table.streamEnabled ? 'success' : 'neutral'" variant="soft">
            {{ props.table.streamEnabled ? t('dynamo.enabled') : t('dynamo.disabled') }}
          </TBadge>
          <TTag v-if="props.table.streamViewType" size="sm" variant="soft">
            {{ props.table.streamViewType }}
          </TTag>
        </TStack>
        <TText v-if="props.table.streamArn" tone="muted" family="mono" style="font-size: 0.7rem;">
          {{ props.table.streamArn }}
        </TText>
        <TText v-else tone="muted" size="xs">
          {{ t('dynamo.streamsNote') }}
        </TText>
      </TStack>
    </TCard>

    <TCard variant="outline">
      <template #header>
        <TText weight="semibold">{{ t('dynamo.identifier') }}</TText>
      </template>
      <TStack direction="vertical" gap="0.25rem">
        <TText tone="muted" family="mono" size="xs">
          ARN: {{ props.table.arn || '—' }}
        </TText>
        <TText tone="muted" size="xs">
          {{ t('common.created') }}: {{ props.table.createdAt ? new Date(props.table.createdAt).toLocaleString() : '—' }}
        </TText>
      </TStack>
    </TCard>
  </TStack>
</template>
