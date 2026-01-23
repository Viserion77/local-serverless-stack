<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api } from '../services/api';

const resources = ref<{ tables: string[]; queues: string[]; topics: string[] }>({
  tables: [],
  queues: [],
  topics: [],
});
const loading = ref(true);

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
  setInterval(loadResources, 15000);
});
</script>

<template>
  <div class="grid grid-cols-3">
    <div class="stat-card">
      <div class="stat-label">
        DynamoDB Tables
      </div>
      <div class="stat-value">
        {{ loading ? '...' : resources.tables.length }}
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-label">
        SQS Queues
      </div>
      <div class="stat-value">
        {{ loading ? '...' : resources.queues.length }}
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-label">
        SNS Topics
      </div>
      <div class="stat-value">
        {{ loading ? '...' : resources.topics.length }}
      </div>
    </div>
  </div>
</template>
