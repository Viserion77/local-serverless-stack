<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import {
  TNavbar, TContainer, TStack, TBadge, TTabs, TTabList, TTab, TTabPanel,
  TToastProvider, TButton,
} from '@treeui/vue';
import ServicesList from './components/ServicesList.vue';
import ResourcesOverview from './components/ResourcesOverview.vue';
import QueuesView from './components/QueuesView.vue';
import { api } from './services/api';

const health = ref({ status: 'unknown', localstack: false });
const activeTab = ref('overview');
const theme = ref<'dark' | 'light'>(
  (document.documentElement.getAttribute('data-tree-theme') as 'dark' | 'light') || 'dark',
);
let healthTimer: number | null = null;

async function checkHealth() {
  try {
    health.value = await api.checkHealth();
  } catch (error) {
    console.error('Health check failed:', error);
  }
}

function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-tree-theme', theme.value);
}

onMounted(() => {
  checkHealth();
  healthTimer = window.setInterval(checkHealth, 10000);
});

onBeforeUnmount(() => {
  if (healthTimer) window.clearInterval(healthTimer);
});
</script>

<template>
  <TToastProvider position="top-right">
    <div class="app-shell">
      <TNavbar sticky bordered>
        <template #start>
          <TStack direction="vertical" gap="0.125rem">
            <strong>Local Serverless Stack</strong>
            <span class="muted" style="font-size: 0.75rem;">
              Local development control plane
            </span>
          </TStack>
        </template>
        <template #end>
          <TStack direction="horizontal" gap="0.5rem" align="center">
            <TBadge
              :tone="health.localstack ? 'success' : 'danger'"
              variant="soft"
            >
              LocalStack: {{ health.localstack ? 'Running' : 'Offline' }}
            </TBadge>
            <TButton size="sm" variant="ghost" @click="toggleTheme">
              {{ theme === 'dark' ? 'Light' : 'Dark' }}
            </TButton>
          </TStack>
        </template>
      </TNavbar>

      <main class="app-main">
        <TContainer size="xl" padded>
          <TTabs v-model="activeTab">
            <TTabList>
              <TTab value="overview">Overview</TTab>
              <TTab value="services">Services</TTab>
              <TTab value="queues">Queues</TTab>
            </TTabList>

            <TTabPanel value="overview">
              <div style="padding-top: 1.25rem;">
                <ResourcesOverview />
              </div>
            </TTabPanel>

            <TTabPanel value="services">
              <div style="padding-top: 1.25rem;">
                <ServicesList />
              </div>
            </TTabPanel>

            <TTabPanel value="queues">
              <div style="padding-top: 1.25rem;">
                <QueuesView />
              </div>
            </TTabPanel>
          </TTabs>
        </TContainer>
      </main>
    </div>
  </TToastProvider>
</template>
