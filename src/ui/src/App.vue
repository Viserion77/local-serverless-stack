<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';
import {
  TNavbar, TStack, TBadge, TToastProvider, TButton, TSelect,
  TTabs, TTabList, TTab, TDropdown,
} from '@treeui/vue';
import { currentRegion, AWS_REGIONS } from './services/region';
import { api } from './services/api';
import type { HealthInfo } from './services/api';

const route = useRoute();
const router = useRouter();

const health = ref<HealthInfo>({
  status: 'unknown',
  localstack: false,
  dynamoProxy: { enabled: false, running: false, port: 8000 },
});
const theme = ref<'dark' | 'light'>(
  (document.documentElement.getAttribute('data-tree-theme') as 'dark' | 'light') || 'dark',
);
let healthTimer: number | null = null;

// Top-level segment so nested routes (e.g. /services/foo) still light up the
// matching nav item.
const activeTopLevel = computed(() => {
  const segs = route.path.split('/').filter(Boolean);
  return segs.length === 0 ? '/' : `/${segs[0]}`;
});

const menuItems = computed(() => [
  { label: theme.value === 'dark' ? 'Switch to light' : 'Switch to dark', value: 'theme' },
]);

function onNavSelect(value: string) {
  if (value && value !== activeTopLevel.value) router.push(value);
}

function onMenuSelect(value: string) {
  if (value === 'theme') {
    theme.value = theme.value === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-tree-theme', theme.value);
  }
}

async function checkHealth() {
  try {
    health.value = await api.checkHealth();
  } catch (error) {
    console.error('Health check failed:', error);
  }
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

        <template #center>
          <TTabs
            :model-value="activeTopLevel"
            @update:model-value="onNavSelect"
          >
            <TTabList>
              <TTab value="/">Overview</TTab>
              <TTab value="/services">Services</TTab>
              <TTab value="/queues">Queues</TTab>
              <TTab value="/buckets">S3</TTab>
              <TTab value="/dynamo">DynamoDB</TTab>
            </TTabList>
          </TTabs>
        </template>

        <template #end>
          <TStack direction="horizontal" gap="0.5rem" align="center">
            <TBadge
              :tone="health.localstack ? 'success' : 'danger'"
              variant="soft"
            >
              LocalStack: {{ health.localstack ? 'Running' : 'Offline' }}
            </TBadge>
            <TBadge
              v-if="health.dynamoProxy?.enabled"
              :tone="health.dynamoProxy.running ? 'success' : 'warning'"
              variant="soft"
            >
              Dynamo Proxy: {{ health.dynamoProxy.running ? 'On' : 'Off' }}
            </TBadge>
            <TSelect
              v-model="currentRegion"
              :options="AWS_REGIONS"
              size="sm"
              style="min-width: 14rem;"
              aria-label="AWS Region"
            />
            <TDropdown
              :items="menuItems"
              size="sm"
              label="Open menu"
              @select="onMenuSelect"
            >
              <template #trigger>
                <TButton size="sm" variant="ghost" aria-label="Open menu">
                  ⋮
                </TButton>
              </template>
            </TDropdown>
          </TStack>
        </template>
      </TNavbar>

      <main class="app-main">
        <div :key="`${route.fullPath}-${currentRegion}`">
          <RouterView />
        </div>
      </main>
    </div>
  </TToastProvider>
</template>
