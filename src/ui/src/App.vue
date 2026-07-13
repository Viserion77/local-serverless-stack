<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';
import {
  TNavbar, TStack, TBadge, TToastProvider, TButton, TSelect,
  TTabs, TTabList, TTab, TDropdown,
} from '@treeui/vue';
import { currentRegion, regionOptions, applyConfiguredRegion } from './services/region';
import { api } from './services/api';
import type { HealthInfo } from './services/api';
import { branding, loadBranding, applyTheme } from './services/branding';

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
    applyTheme(theme.value, true);
  }
}

async function checkHealth() {
  try {
    health.value = await api.checkHealth();
  } catch (error) {
    console.error('Health check failed:', error);
  }
}

onMounted(async () => {
  checkHealth();
  healthTimer = window.setInterval(checkHealth, 10000);
  // Server-configured region wins over the locally stored one on every load —
  // but a region the user picks while /api/config is in flight must stick.
  const regionAtMount = currentRegion.value;
  api.getConfig()
    .then((config) => applyConfiguredRegion(config.region, currentRegion.value !== regionAtMount))
    .catch(() => { /* keep stored/default region */ });
  await loadBranding();
  theme.value =
    (document.documentElement.getAttribute('data-tree-theme') as 'dark' | 'light') || 'dark';
});

onBeforeUnmount(() => {
  if (healthTimer) window.clearInterval(healthTimer);
});
</script>

<template>
  <TToastProvider position="top-right">
    <div class="app-shell">
      <header class="app-header">
        <TNavbar as="div" bordered>
          <template #start>
            <TStack direction="horizontal" gap="0.625rem" align="center">
              <img
                v-if="branding.logoUrl"
                :src="branding.logoUrl"
                :alt="`${branding.title} logo`"
                class="brand-logo"
              />
              <TStack direction="vertical" gap="0.125rem">
                <strong>{{ branding.title }}</strong>
                <span v-if="branding.subtitle" class="muted" style="font-size: 0.75rem;">
                  {{ branding.subtitle }}
                </span>
              </TStack>
            </TStack>
          </template>

          <template #end>
            <div class="app-header-controls">
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
                :options="regionOptions"
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
            </div>
          </template>
        </TNavbar>

        <nav class="app-subnav" aria-label="Primary">
          <TTabs
            :model-value="activeTopLevel"
            @update:model-value="onNavSelect"
          >
            <TTabList>
              <TTab value="/">Overview</TTab>
              <TTab value="/services">Services</TTab>
              <TTab value="/lambdas">Lambdas</TTab>
              <TTab value="/apis">APIs</TTab>
              <TTab value="/queues">Queues</TTab>
              <TTab value="/buckets">S3</TTab>
              <TTab value="/dynamo">DynamoDB</TTab>
              <TTab value="/opensearch">OpenSearch</TTab>
              <TTab value="/secrets">Secrets</TTab>
            </TTabList>
          </TTabs>
        </nav>
      </header>

      <main class="app-main">
        <div :key="`${route.fullPath}-${currentRegion}`">
          <RouterView />
        </div>
      </main>
    </div>
  </TToastProvider>
</template>
