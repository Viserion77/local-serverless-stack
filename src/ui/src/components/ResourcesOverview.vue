<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { TGrid, TStat, TCard, TStack, TBadge, TTag } from '@treeui/vue';
import { api } from '../services/api';

const resources = ref<{ tables: string[]; queues: string[]; topics: string[] }>({
  tables: [],
  queues: [],
  topics: [],
});
const loading = ref(true);
let timer: number | null = null;

async function loadResources() {
  try {
    resources.value = await api.listResources();
  } catch (error) {
    console.error('Failed to load resources:', error);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  loadResources();
  timer = window.setInterval(loadResources, 15000);
});

onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer);
});
</script>

<template>
  <TStack direction="vertical" gap="1.25rem">
    <TGrid :columns="3" gap="1rem">
      <TStat
        label="DynamoDB Tables"
        :value="resources.tables.length"
        tone="info"
        :loading="loading"
      />
      <TStat
        label="SQS Queues"
        :value="resources.queues.length"
        tone="success"
        :loading="loading"
      />
      <TStat
        label="SNS Topics"
        :value="resources.topics.length"
        tone="warning"
        :loading="loading"
      />
    </TGrid>

    <TCard
      title="Provisioned resources"
      variant="outline"
    >
      <template #header>
        <TStack direction="horizontal" gap="0.5rem" align="center">
          <strong>Provisioned resources</strong>
          <TBadge tone="neutral" variant="soft">
            {{ resources.tables.length + resources.queues.length + resources.topics.length }} total
          </TBadge>
        </TStack>
      </template>

      <TStack direction="vertical" gap="0.75rem">
        <TStack direction="horizontal" gap="0.5rem" align="center" wrap>
          <TBadge tone="info">Tables</TBadge>
          <TTag
            v-for="t in resources.tables"
            :key="`tbl-${t}`"
            variant="soft"
            size="sm"
          >
            {{ t }}
          </TTag>
          <span v-if="!resources.tables.length" class="muted">none</span>
        </TStack>

        <TStack direction="horizontal" gap="0.5rem" align="center" wrap>
          <TBadge tone="success">Queues</TBadge>
          <TTag
            v-for="q in resources.queues"
            :key="`q-${q}`"
            variant="soft"
            size="sm"
          >
            {{ q }}
          </TTag>
          <span v-if="!resources.queues.length" class="muted">none</span>
        </TStack>

        <TStack direction="horizontal" gap="0.5rem" align="center" wrap>
          <TBadge tone="warning">Topics</TBadge>
          <TTag
            v-for="t in resources.topics"
            :key="`tp-${t}`"
            variant="soft"
            size="sm"
          >
            {{ t }}
          </TTag>
          <span v-if="!resources.topics.length" class="muted">none</span>
        </TStack>
      </TStack>
    </TCard>
  </TStack>
</template>
