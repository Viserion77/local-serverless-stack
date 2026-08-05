<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';
import {
  TStack, TStackItem, TBrandLockup, TIcon, TPage, TBadge, TToastProvider, TButton, TSelect,
  TAppShell, TNavMenu, TDropdown,
} from '@treeui/vue';
import type { TDropdownItem, TNavMenuItem } from '@treeui/vue';
import { currentRegion, regionOptions, applyConfiguredRegion } from './services/region';
import { api } from './services/api';
import type { HealthInfo } from './services/api';
import { branding, loadBranding, applyTheme } from './services/branding';
import { useI18n } from './i18n';

const { t, locale, setLocale, locales, localeLabels } = useI18n();

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

// Language names are endonyms ("Português (BR)"), so they are NOT translated —
// a reader looking for their own language finds it written the way they write
// it. Which one is in effect is the ITEM's state since 0.28: `selected` turns
// the row into `role="menuitemradio"` with `aria-checked`, so the active
// language is announced as the chosen one in a group of three. The two earlier
// shapes are both gone with it — a ' ✓' glued onto the label (a Unicode glyph
// doing an icon's job, ui-ux.md rule 3, and a silent one) and then a `#item`
// slot drawing a `TIcon check`, which was the local stand-in for state the
// item could not express.
//
// The theme row leaves `selected` UNDEFINED on purpose: it is an action, not a
// member of that group, and the component keys the role off `!== undefined` —
// even `false` would promote it to a radio item with an "unchecked" reading.
const menuItems = computed<TDropdownItem[]>(() => [
  { label: theme.value === 'dark' ? t('nav.switchToLight') : t('nav.switchToDark'), value: 'theme' },
  ...locales.map(code => ({
    label: localeLabels[code],
    value: `locale:${code}`,
    selected: code === locale.value,
  })),
]);

// Recomputed on a language switch; the AWS service names stay untranslated
// because that is what they are called in every console and SDK.
//
// Every row carries an icon, and that is deliberate: TNavMenu falls back to a
// one-letter marker for an icon-less item, so a partly-iconified rail would
// collapse Services / S3 / Secrets / Settings into four identical "S" tiles.
// Which SOURCE the icon comes from still follows ui-ux.md rule 3 — a section
// that IS an AWS service gets the official AWS mark, a section that is an LSS
// concept (the dashboard itself, the registered microservices, the stack's own
// configuration) gets a TreeUI functional icon. Icons are what remains visible
// once the shell collapses, so this is also what makes the collapsed rail
// readable. TNavMenuItem.icon is TIconInput: a registered name needs no import
// and no markRaw, and it keeps the item plain data inside this computed.
const navItems = computed<TNavMenuItem[]>(() => [
  { label: t('nav.overview'), value: '/', icon: 'layout-dashboard' },
  { label: t('nav.services'), value: '/services', icon: 'boxes' },
  { label: t('nav.lambdas'), value: '/lambdas', icon: 'aws-lambda' },
  { label: t('nav.apis'), value: '/apis', icon: 'aws-api-gateway' },
  { label: t('nav.queues'), value: '/queues', icon: 'aws-sqs' },
  { label: 'S3', value: '/buckets', icon: 'aws-s3' },
  { label: 'DynamoDB', value: '/dynamo', icon: 'aws-dynamodb' },
  { label: 'OpenSearch', value: '/opensearch', icon: 'aws-opensearch' },
  { label: t('nav.secrets'), value: '/secrets', icon: 'aws-secrets-manager' },
  { label: t('nav.settings'), value: '/settings', icon: 'settings' },
]);

function onNavSelect(value: string) {
  if (value && value !== activeTopLevel.value) router.push(value);
}

function onMenuSelect(value: string) {
  if (value === 'theme') {
    theme.value = theme.value === 'dark' ? 'light' : 'dark';
    applyTheme(theme.value, true);
    return;
  }
  if (value.startsWith('locale:')) {
    setLocale(value.slice('locale:'.length) as typeof locale.value);
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
    <!-- Every string the shell speaks is the product's, not the library's: the
         defaults ("Sidebar", "Open menu", "Collapse sidebar") are English
         constants inside TreeUI, and they are all accessible names — the one
         kind of copy a trilingual UI cannot afford to leave untranslated
         (ui-ux.md rule 6). `skip-link-label` is 0.27: the shell wires a skip
         link to its own <main> as the first focusable element, but only renders
         it once given copy, so this is what gives the dashboard a keyboard
         bypass over the ten-item nav rail for the first time. -->
    <TAppShell
      collapsible
      sidebar-width="16rem"
      :sidebar-label="t('nav.sidebar')"
      :skip-link-label="t('nav.skipToContent')"
      :menu-label="t('nav.openNavigation')"
      :close-label="t('nav.closeNavigation')"
      :collapse-label="t('nav.collapseSidebar')"
      :expand-label="t('nav.expandSidebar')"
    >
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
            {{ t('nav.engine') }}: {{ engineRunning ? t('nav.engineRunning') : t('nav.engineOffline') }}
          </TBadge>
          <TBadge
            v-if="health.dynamoProxy?.enabled"
            :tone="health.dynamoProxy.running ? 'success' : 'warning'"
            variant="soft"
          >
            {{ t('nav.dynamoProxy') }}: {{ health.dynamoProxy.running ? t('nav.on') : t('nav.off') }}
          </TBadge>
          <TStackItem min-width="14rem">
            <TSelect
              v-model="currentRegion"
              :options="regionOptions"
              size="sm"
              :aria-label="t('nav.awsRegion')"
            />
          </TStackItem>
          <TDropdown
            :items="menuItems"
            size="sm"
            :label="t('nav.openMenu')"
            @select="onMenuSelect"
          >
            <template #trigger>
              <TButton icon-only size="sm" variant="ghost" :label="t('nav.openMenu')">
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
          :aria-label="t('nav.primary')"
          @select="onNavSelect"
        />
      </template>

      <TPage width="full" :key="`${route.fullPath}-${currentRegion}`">
        <RouterView />
      </TPage>
    </TAppShell>
  </TToastProvider>
</template>
