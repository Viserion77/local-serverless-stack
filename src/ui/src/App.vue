<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';
import {
  TStack, TStackItem, TBrandLockup, TIcon, TPage, TBadge, TToastProvider, TButton, TSelect,
  TAppShell, TNavMenu, TDropdown,
} from '@treeui/vue';
import type { TNavMenuItem } from '@treeui/vue';
import { currentRegion, regionOptions, applyConfiguredRegion } from './services/region';
import { api } from './services/api';
import type { HealthInfo } from './services/api';
import { branding, loadBranding, applyTheme } from './services/branding';

const route = useRoute();
const router = useRouter();

const health = ref<HealthInfo>({
  status: 'unknown',
  engineRunning: false,
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

const navItems: TNavMenuItem[] = [
  { label: 'Overview', value: '/' },
  { label: 'Services', value: '/services' },
  { label: 'Lambdas', value: '/lambdas' },
  { label: 'APIs', value: '/apis' },
  { label: 'Queues', value: '/queues' },
  { label: 'S3', value: '/buckets' },
  { label: 'DynamoDB', value: '/dynamo' },
  { label: 'OpenSearch', value: '/opensearch' },
  { label: 'Secrets', value: '/secrets' },
  { label: 'Settings', value: '/settings' },
];

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

const engineRunning = computed(() => health.value.engineRunning);

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
    <TAppShell collapsible sidebar-width="16rem" sidebar-label="Primary navigation">
      <!-- Brand in #header-start (over the sidebar rail, animates with the collapse) and controls in
           #header-end (0.20 slot, pinned trailing) — the shell header grid owns the layout. The brand
           is TBrandLockup (0.21): the #logo slot keeps the arbitrary-ratio branding image uncropped,
           and it hides the wordmark when the shell collapses. -->
      <template #header-start="{ collapsed }">
        <TBrandLockup
          :title="branding.title"
          :subtitle="branding.subtitle"
          :collapsed="collapsed"
        >
          <template #logo>
            <img
              v-if="branding.logoUrl"
              :src="branding.logoUrl"
              :alt="`${branding.title} logo`"
            />
          </template>
        </TBrandLockup>
      </template>

      <template #header-end>
        <TStack direction="horizontal" gap="0.5rem" align="center" wrap>
          <TBadge
            :tone="engineRunning ? 'success' : 'danger'"
            variant="soft"
          >
            Engine: {{ engineRunning ? 'Running' : 'Offline' }}
          </TBadge>
          <TBadge
            v-if="health.dynamoProxy?.enabled"
            :tone="health.dynamoProxy.running ? 'success' : 'warning'"
            variant="soft"
          >
            Dynamo Proxy: {{ health.dynamoProxy.running ? 'On' : 'Off' }}
          </TBadge>
          <TStackItem min-width="14rem">
            <TSelect
              v-model="currentRegion"
              :options="regionOptions"
              size="sm"
              aria-label="AWS Region"
            />
          </TStackItem>
          <TDropdown
            :items="menuItems"
            size="sm"
            label="Open menu"
            @select="onMenuSelect"
          >
            <template #trigger>
              <TButton icon-only size="sm" variant="ghost" label="Open menu">
                <template #icon>
                  <TIcon name="ellipsis-vertical" />
                </template>
              </TButton>
            </template>
          </TDropdown>
        </TStack>
      </template>

      <template #sidebar>
        <TNavMenu
          :items="navItems"
          :model-value="activeTopLevel"
          aria-label="Primary"
          @select="onNavSelect"
        />
      </template>

      <TPage width="full" :key="`${route.fullPath}-${currentRegion}`">
        <RouterView />
      </TPage>
    </TAppShell>
  </TToastProvider>
</template>
