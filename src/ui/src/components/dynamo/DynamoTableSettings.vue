<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  TCard, TButton, TStack, TGrid, TStat, TBadge, TSwitch, TInput, TAlert,
  TFormField, TTag, useToast,
} from '@treeui/vue';
import { api } from '../../services/api';
import type { DynamoTableDetail } from '../../services/api';

const props = defineProps<{ table: DynamoTableDetail }>();
const emit = defineEmits<{ (e: 'refresh'): void }>();

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
    error.value = 'Attribute name is required to enable TTL';
    return;
  }
  saving.value = true;
  error.value = null;
  try {
    await api.setDynamoTtl(props.table.name, ttlEnabled.value, ttlAttribute.value.trim() || undefined);
    toast.add({
      title: ttlEnabled.value ? 'TTL enabled' : 'TTL disabled',
      description: ttlEnabled.value ? `Attribute: ${ttlAttribute.value}` : undefined,
      variant: 'success',
    });
    emit('refresh');
  } catch (err: any) {
    error.value = err.message || 'Failed to update TTL';
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
      <TStat label="Items" :value="props.table.itemCount" tone="info" />
      <TStat label="Size" :value="formatBytes(props.table.sizeBytes)" tone="neutral" />
      <TStat
        label="Status"
        :value="props.table.status || 'UNKNOWN'"
        :tone="props.table.status === 'ACTIVE' ? 'success' : 'warning'"
      />
      <TStat label="Billing" :value="props.table.billingMode || '—'" tone="neutral" />
    </TGrid>

    <TCard variant="outline">
      <template #header>
        <strong>Time to Live (TTL)</strong>
      </template>

      <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
        {{ error }}
      </TAlert>

      <TStack direction="vertical" gap="0.75rem">
        <span class="muted" style="font-size: 0.8rem;">
          When TTL is enabled, items are automatically deleted by DynamoDB after the timestamp in the configured attribute (epoch seconds). Items are eventually consistent and may take time to be removed.
        </span>

        <TFormField label="Enable TTL">
          <TSwitch v-model="ttlEnabled" />
        </TFormField>

        <TFormField
          label="Attribute name"
          :hint="ttlEnabled ? 'Required when enabling TTL' : 'Disabled — value retained for reference'"
        >
          <TInput
            v-model="ttlAttribute"
            placeholder="e.g. expiresAt"
            :disabled="!ttlEnabled"
          />
        </TFormField>

        <TStack direction="horizontal" justify="flex-end">
          <TButton size="sm" variant="solid" :loading="saving" @click="applyTtl">
            Apply
          </TButton>
        </TStack>
      </TStack>
    </TCard>

    <TCard variant="outline">
      <template #header>
        <strong>Streams</strong>
      </template>
      <TStack direction="vertical" gap="0.5rem">
        <TStack direction="horizontal" gap="0.5rem" align="center">
          <TBadge :tone="props.table.streamEnabled ? 'success' : 'neutral'" variant="soft">
            {{ props.table.streamEnabled ? 'Enabled' : 'Disabled' }}
          </TBadge>
          <TTag v-if="props.table.streamViewType" size="sm" variant="soft">
            {{ props.table.streamViewType }}
          </TTag>
        </TStack>
        <span v-if="props.table.streamArn" class="muted mono" style="font-size: 0.7rem;">
          {{ props.table.streamArn }}
        </span>
        <span v-else class="muted" style="font-size: 0.75rem;">
          Streams configuration is set at table creation time and cannot be changed from here.
        </span>
      </TStack>
    </TCard>

    <TCard variant="outline">
      <template #header>
        <strong>Identifier</strong>
      </template>
      <TStack direction="vertical" gap="0.25rem">
        <span class="muted mono" style="font-size: 0.75rem;">
          ARN: {{ props.table.arn || '—' }}
        </span>
        <span class="muted" style="font-size: 0.75rem;">
          Created: {{ props.table.createdAt ? new Date(props.table.createdAt).toLocaleString() : '—' }}
        </span>
      </TStack>
    </TCard>
  </TStack>
</template>
