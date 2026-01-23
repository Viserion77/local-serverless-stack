<script setup lang="ts">
import { ref, onMounted } from 'vue';
import ServicesList from './components/ServicesList.vue';
import ResourcesOverview from './components/ResourcesOverview.vue';
import { api } from './services/api';

const health = ref({ status: 'unknown', localstack: false });

async function checkHealth() {
  try {
    health.value = await api.checkHealth();
  } catch (error) {
    console.error('Health check failed:', error);
  }
}

onMounted(() => {
  checkHealth();
  setInterval(checkHealth, 10000);
});
</script>

<template>
  <div>
    <header class="header">
      <h1>Local Serverless Stack Orchestrator</h1>
      <p class="header-subtitle">
        Local development control plane • LocalStack:
        <span :style="{ color: health.localstack ? 'var(--success)' : 'var(--danger)' }">
          {{ health.localstack ? '✓ Running' : '✗ Offline' }}
        </span>
      </p>
    </header>

    <div class="container">
      <ResourcesOverview />
      <ServicesList />
    </div>
  </div>
</template>
