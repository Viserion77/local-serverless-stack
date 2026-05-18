<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import {
  TCard, TButton, TBadge, TStack, TGrid, TStat, TEmptyState,
  TSpinner, TAlert, TTag,
} from '@treeui/vue';
import { api } from '../../services/api';
import type { DynamoTableSummary } from '../../services/api';

const emit = defineEmits<{ (e: 'open', name: string): void }>();

const tables = ref<DynamoTableSummary[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
let timer: number | null = null;

const totals = computed(() => ({
  tables: tables.value.length,
  items: tables.value.reduce((s, t) => s + (t.itemCount || 0), 0),
  warnings: tables.value.reduce((s, t) => s + (t.warnings?.length || 0), 0),
}));

async function load() {
  try {
    const res = await api.listDynamoTables();
    tables.value = res.tables;
    error.value = null;
  } catch (err: any) {
    error.value = err.message || 'Failed to load DynamoDB tables';
  } finally {
    loading.value = false;
  }
}

function keyDescriptor(t: DynamoTableSummary): string {
  const pk = t.keySchema.find(k => k.KeyType === 'HASH')?.AttributeName;
  const sk = t.keySchema.find(k => k.KeyType === 'RANGE')?.AttributeName;
  return sk ? `PK: ${pk} · SK: ${sk}` : `PK: ${pk ?? '—'}`;
}

onMounted(() => {
  load();
  timer = window.setInterval(load, 15000);
});

onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer);
});
</script>

<template>
  <TStack direction="vertical" gap="1.25rem">
    <TGrid :columns="3" gap="1rem">
      <TStat label="Tables" :value="totals.tables" tone="info" :loading="loading" />
      <TStat label="Total items" :value="totals.items" tone="success" :loading="loading" />
      <TStat
        label="Warnings"
        :value="totals.warnings"
        :tone="totals.warnings > 0 ? 'warning' : 'neutral'"
        :loading="loading"
      />
    </TGrid>

    <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
      {{ error }}
    </TAlert>

    <div v-if="loading" style="display: flex; justify-content: center; padding: 2rem;">
      <TSpinner label="Loading tables..." />
    </div>

    <TEmptyState
      v-else-if="!tables.length"
      title="No DynamoDB tables"
      description="Register a microservice with DynamoDB resources or create tables directly in LocalStack."
    />

    <TGrid v-else :columns="2" gap="1rem">
      <TCard
        v-for="t in tables"
        :key="t.name"
        variant="outline"
        clickable
        @click="emit('open', t.name)"
      >
        <template #header>
          <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
            <TStack direction="vertical" gap="0.125rem">
              <strong>{{ t.name }}</strong>
              <span class="muted mono" style="font-size: 0.75rem;">{{ keyDescriptor(t) }}</span>
            </TStack>
            <TBadge :tone="t.status === 'ACTIVE' ? 'success' : 'warning'" variant="soft">
              {{ t.status || 'UNKNOWN' }}
            </TBadge>
          </TStack>
        </template>

        <TStack direction="vertical" gap="0.75rem">
          <TStack direction="horizontal" gap="0.5rem" wrap>
            <TTag size="sm" variant="soft">Items: {{ t.itemCount }}</TTag>
            <TTag size="sm" variant="soft">{{ t.billingMode || '—' }}</TTag>
            <TTag size="sm" :variant="t.ttl.enabled ? 'solid' : 'outline'">
              TTL: {{ t.ttl.enabled ? (t.ttl.attributeName || 'on') : 'off' }}
            </TTag>
            <TTag size="sm" :variant="t.streamEnabled ? 'solid' : 'outline'">
              Streams: {{ t.streamEnabled ? 'on' : 'off' }}
            </TTag>
            <TTag v-if="t.hasGsi" size="sm" variant="soft">GSI</TTag>
            <TTag v-if="t.hasLsi" size="sm" variant="soft">LSI</TTag>
          </TStack>

          <TStack v-if="t.warnings.length" direction="horizontal" gap="0.375rem" wrap>
            <TBadge v-for="w in t.warnings" :key="w" tone="warning" variant="soft">⚠ {{ w }}</TBadge>
          </TStack>
        </TStack>

        <template #footer>
          <TStack direction="horizontal" justify="flex-end">
            <TButton size="sm" variant="soft" @click.stop="emit('open', t.name)">
              Explore
            </TButton>
          </TStack>
        </template>
      </TCard>
    </TGrid>
  </TStack>
</template>
