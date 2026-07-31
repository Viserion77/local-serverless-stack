<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  TButton, TBadge, TStack, TTabs, TTabList, TTab, TTabPanel, TSpinner, TAlert,
  TCard, TTag, TEmptyState, TGrid, TText, TIcon,
} from '@treeui/vue';
import { api } from '../../services/api';
import type { DynamoTableDetail, SeedFileEntry } from '../../services/api';
import DynamoItemsExplorer from './DynamoItemsExplorer.vue';
import DynamoTableSettings from './DynamoTableSettings.vue';
import DynamoSeedPanel from './DynamoSeedPanel.vue';
import { useI18n } from '../../i18n';

const { t } = useI18n();

const props = defineProps<{ tableName: string }>();
const emit = defineEmits<{ (e: 'back'): void }>();

const route = useRoute();
const router = useRouter();

const table = ref<DynamoTableDetail | null>(null);
const seedEntry = ref<SeedFileEntry | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

const VALID_TABS = ['items', 'indexes', 'settings', 'seed'] as const;
type TabValue = typeof VALID_TABS[number];

const activeTab = computed<TabValue>({
  get() {
    const q = String(route.query.tab || '');
    return (VALID_TABS as readonly string[]).includes(q) ? (q as TabValue) : 'items';
  },
  set(value) {
    router.replace({ query: { ...route.query, tab: value === 'items' ? undefined : value } });
  },
});

async function load() {
  loading.value = true;
  try {
    const [detail, seedsRes] = await Promise.all([
      api.describeDynamoTable(props.tableName),
      api.listSeeds().catch(() => ({ seedsDir: '', entries: [] as SeedFileEntry[] })),
    ]);
    table.value = detail;
    seedEntry.value = seedsRes.entries.find(e => e.tableName === props.tableName) || null;
    error.value = null;
  } catch (err: any) {
    error.value = err.message || t('dynamo.loadTableFailed');
    table.value = null;
  } finally {
    loading.value = false;
  }
}

// Singular/plural picked at render time so the badge follows a language switch.
function seedBadgeLabel(count: number): string {
  return count === 1
    ? t('dynamo.seedBadgeOne', { count })
    : t('dynamo.seedBadgeOther', { count });
}

onMounted(load);
watch(() => props.tableName, load);
</script>

<template>
  <TStack direction="vertical" gap="1rem">
    <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
      <TStack direction="horizontal" gap="0.5rem" align="center">
        <TButton size="sm" variant="ghost" @click="emit('back')"><TIcon name="arrow-left" /> {{ t('dynamo.backTables') }}</TButton>
        <!-- Detail-screen identity, decorative: the back link names the
             DynamoDB table list this page came from. -->
        <TIcon name="aws-dynamodb" />
        <TText size="lg" weight="semibold">{{ tableName }}</TText>
        <TBadge
          v-if="table?.status"
          :tone="table.status === 'ACTIVE' ? 'success' : 'warning'"
          variant="soft"
        >
          {{ table.status }}
        </TBadge>
        <TBadge
          v-if="seedEntry"
          tone="info"
          variant="soft"
        >
          {{ seedBadgeLabel(seedEntry.itemCount) }}
        </TBadge>
      </TStack>
      <TButton size="sm" variant="ghost" :loading="loading" @click="load">{{ t('common.refresh') }}</TButton>
    </TStack>

    <TStack
      v-if="table?.warnings.length"
      direction="horizontal"
      gap="0.375rem"
      wrap
    >
      <TBadge v-for="w in table.warnings" :key="w" tone="warning" variant="soft"><TIcon name="triangle-alert" /> {{ w }}</TBadge>
    </TStack>

    <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
      {{ error }}
    </TAlert>

    <TStack v-if="loading && !table" direction="horizontal" justify="center" align="center">
      <TSpinner :label="t('dynamo.loadingTable')" />
    </TStack>

    <TTabs v-else-if="table" v-model="activeTab">
      <TTabList>
        <TTab value="items">{{ t('dynamo.items') }}</TTab>
        <TTab value="indexes">{{ t('dynamo.indexes') }}</TTab>
        <TTab value="settings">{{ t('dynamo.settings') }}</TTab>
        <TTab v-if="seedEntry" value="seed">{{ t('dynamo.seed') }}</TTab>
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
            :title="t('dynamo.noIndexesTitle')"
            :description="t('dynamo.noIndexesDesc')"
          />
          <TStack v-else direction="vertical" gap="1rem">
            <TGrid v-if="table.gsis.length" :columns="2" gap="0.75rem">
              <TCard v-for="idx in table.gsis" :key="idx.IndexName" variant="outline">
                <template #header>
                  <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
                    <TText weight="semibold">{{ idx.IndexName }}</TText>
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
                  <TText tone="muted" size="xs">
                    {{ t('dynamo.projection') }}: {{ idx.Projection?.ProjectionType || '—' }}
                    · {{ t('dynamo.items') }}: {{ idx.ItemCount ?? '—' }}
                    · {{ t('common.status') }}: {{ idx.IndexStatus || '—' }}
                  </TText>
                </TStack>
              </TCard>
            </TGrid>

            <TGrid v-if="table.lsis.length" :columns="2" gap="0.75rem">
              <TCard v-for="idx in table.lsis" :key="idx.IndexName" variant="outline">
                <template #header>
                  <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
                    <TText weight="semibold">{{ idx.IndexName }}</TText>
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
                  <TText tone="muted" size="xs">
                    {{ t('dynamo.projection') }}: {{ idx.Projection?.ProjectionType || '—' }}
                  </TText>
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

      <TTabPanel v-if="seedEntry" value="seed">
        <div style="padding-top: 1rem;">
          <DynamoSeedPanel
            :table-name="table.name"
            :seed-file="seedEntry.file"
            :seed-item-count="seedEntry.itemCount"
            :table-item-count="table.itemCount"
            @refresh="load"
          />
        </div>
      </TTabPanel>
    </TTabs>
  </TStack>
</template>
