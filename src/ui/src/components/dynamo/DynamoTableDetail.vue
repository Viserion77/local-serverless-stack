<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import {
  TButton, TBadge, TStack, TTabs, TTabList, TTab, TTabPanel, TSpinner, TAlert,
  TCard, TTag, TEmptyState, TGrid,
} from '@treeui/vue';
import { api } from '../../services/api';
import type { DynamoTableDetail } from '../../services/api';
import DynamoItemsExplorer from './DynamoItemsExplorer.vue';
import DynamoTableSettings from './DynamoTableSettings.vue';

const props = defineProps<{ tableName: string }>();
const emit = defineEmits<{ (e: 'back'): void }>();

const table = ref<DynamoTableDetail | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const activeTab = ref<string>('items');

async function load() {
  loading.value = true;
  try {
    table.value = await api.describeDynamoTable(props.tableName);
    error.value = null;
  } catch (err: any) {
    error.value = err.message || 'Failed to load table';
    table.value = null;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(() => props.tableName, load);
</script>

<template>
  <TStack direction="vertical" gap="1rem">
    <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
      <TStack direction="horizontal" gap="0.5rem" align="center">
        <TButton size="sm" variant="ghost" @click="emit('back')">← Tables</TButton>
        <strong style="font-size: 1.1rem;">{{ tableName }}</strong>
        <TBadge
          v-if="table?.status"
          :tone="table.status === 'ACTIVE' ? 'success' : 'warning'"
          variant="soft"
        >
          {{ table.status }}
        </TBadge>
      </TStack>
      <TButton size="sm" variant="ghost" :loading="loading" @click="load">Refresh</TButton>
    </TStack>

    <TStack
      v-if="table?.warnings.length"
      direction="horizontal"
      gap="0.375rem"
      wrap
    >
      <TBadge v-for="w in table.warnings" :key="w" tone="warning" variant="soft">⚠ {{ w }}</TBadge>
    </TStack>

    <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
      {{ error }}
    </TAlert>

    <div v-if="loading && !table" style="display: flex; justify-content: center; padding: 2rem;">
      <TSpinner label="Loading table..." />
    </div>

    <TTabs v-else-if="table" v-model="activeTab">
      <TTabList>
        <TTab value="items">Items</TTab>
        <TTab value="indexes">Indexes</TTab>
        <TTab value="settings">Settings</TTab>
      </TTabList>

      <TTabPanel value="items">
        <div style="padding-top: 1rem;">
          <DynamoItemsExplorer :table="table" />
        </div>
      </TTabPanel>

      <TTabPanel value="indexes">
        <div style="padding-top: 1rem;">
          <TEmptyState
            v-if="!table.gsis.length && !table.lsis.length"
            title="No secondary indexes"
            description="This table has only the primary key."
          />
          <TStack v-else direction="vertical" gap="1rem">
            <TGrid v-if="table.gsis.length" :columns="2" gap="0.75rem">
              <TCard v-for="idx in table.gsis" :key="idx.IndexName" variant="outline">
                <template #header>
                  <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
                    <strong>{{ idx.IndexName }}</strong>
                    <TBadge tone="info" variant="soft">GSI</TBadge>
                  </TStack>
                </template>
                <TStack direction="vertical" gap="0.5rem">
                  <TStack direction="horizontal" gap="0.5rem" wrap>
                    <TTag
                      v-for="k in idx.KeySchema || []"
                      :key="k.AttributeName"
                      size="sm"
                      variant="soft"
                    >
                      {{ k.AttributeName }} ({{ k.KeyType }})
                    </TTag>
                  </TStack>
                  <span class="muted" style="font-size: 0.75rem;">
                    Projection: {{ idx.Projection?.ProjectionType || '—' }}
                    · Items: {{ idx.ItemCount ?? '—' }}
                    · Status: {{ idx.IndexStatus || '—' }}
                  </span>
                </TStack>
              </TCard>
            </TGrid>

            <TGrid v-if="table.lsis.length" :columns="2" gap="0.75rem">
              <TCard v-for="idx in table.lsis" :key="idx.IndexName" variant="outline">
                <template #header>
                  <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
                    <strong>{{ idx.IndexName }}</strong>
                    <TBadge tone="neutral" variant="soft">LSI</TBadge>
                  </TStack>
                </template>
                <TStack direction="vertical" gap="0.5rem">
                  <TStack direction="horizontal" gap="0.5rem" wrap>
                    <TTag
                      v-for="k in idx.KeySchema || []"
                      :key="k.AttributeName"
                      size="sm"
                      variant="soft"
                    >
                      {{ k.AttributeName }} ({{ k.KeyType }})
                    </TTag>
                  </TStack>
                  <span class="muted" style="font-size: 0.75rem;">
                    Projection: {{ idx.Projection?.ProjectionType || '—' }}
                  </span>
                </TStack>
              </TCard>
            </TGrid>
          </TStack>
        </div>
      </TTabPanel>

      <TTabPanel value="settings">
        <div style="padding-top: 1rem;">
          <DynamoTableSettings :table="table" @refresh="load" />
        </div>
      </TTabPanel>
    </TTabs>
  </TStack>
</template>
