<script setup lang="ts">
// The "Web functions" section of the Lambdas screen: Lambda Web Functions —
// HTTP servers run as functions — with the local URL of each endpoint (open /
// copy) and the state of their execution environments. Rendered only when the
// stack has any, so a stack without web functions sees the screen it always had.
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import {
  TCard, TTable, TStack, TTag, TBadge, TText, TLink, TIcon, TButton, TAlert, useToast,
} from '@treeui/vue';
import { api } from '../../services/api';
import type { WebFunctionSummary } from '../../services/api';
import { useI18n } from '../../i18n';
import { webStateTone, webStateLabel } from './webFunctionState';

const { t } = useI18n();
const toast = useToast();

const functions = ref<WebFunctionSummary[]>([]);
const error = ref<string | null>(null);
let refreshTimer: number | null = null;

const columns = computed(() => [
  { key: 'name', label: t('lambdas.function') },
  { key: 'service', label: t('common.service') },
  { key: 'url', label: t('webFunctions.url') },
  { key: 'revisions', label: t('webFunctions.revisions') },
  { key: 'state', label: t('common.status') },
  { key: 'requests', label: t('webFunctions.requests'), align: 'right' as const },
]);

// One row per function; its endpoints are listed inside the URL cell (AWS
// allows several per function, the common case is one).
const rows = computed(() => functions.value.map(fn => ({
  ...fn,
  key: `${fn.service}/${fn.name}`,
  detailTo: `/lambdas/web/${encodeURIComponent(fn.service)}/${encodeURIComponent(fn.name)}`,
})));

async function load() {
  try {
    functions.value = await api.listWebFunctions();
    error.value = null;
  } catch (err: any) {
    error.value = err.message || t('webFunctions.loadFailed');
  }
}

async function copy(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    toast.add({ title: t('webFunctions.copied'), description: url, variant: 'success' });
  } catch {
    toast.add({ title: t('webFunctions.copyFailed'), description: url, variant: 'danger' });
  }
}

onMounted(() => {
  load();
  refreshTimer = window.setInterval(load, 10000);
});

onBeforeUnmount(() => {
  if (refreshTimer) window.clearInterval(refreshTimer);
});
</script>

<template>
  <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
    {{ error }}
  </TAlert>

  <TCard v-if="functions.length" variant="outline">
    <template #header>
      <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
        <TStack direction="horizontal" gap="0.5rem" align="center">
          <TIcon name="aws-lambda" />
          <TText weight="semibold">{{ t('webFunctions.sectionTitle') }}</TText>
          <TBadge tone="info" variant="soft">{{ functions.length }}</TBadge>
        </TStack>
        <TText tone="muted">{{ t('webFunctions.sectionHint') }}</TText>
      </TStack>
    </template>

    <TTable :columns="columns" :rows="rows" row-key="key" :aria-label="t('webFunctions.sectionTitle')">
      <template #cell-name="{ row }">
        <TStack direction="horizontal" gap="0.5rem" align="center">
          <TTag size="sm" tone="info" variant="soft">{{ t('webFunctions.badge') }}</TTag>
          <TLink :to="String(row.detailTo)" weight="semibold">{{ row.name }}</TLink>
        </TStack>
      </template>

      <template #cell-service="{ row }">
        <TLink :to="`/services/${encodeURIComponent(String(row.service))}`" underline="none">
          <TTag size="sm" variant="soft">{{ row.service }}</TTag>
        </TLink>
      </template>

      <template #cell-url="{ row }">
        <TStack direction="vertical" gap="0.25rem">
          <TStack
            v-for="ep in (row as unknown as WebFunctionSummary).endpoints"
            :key="ep.name"
            direction="horizontal"
            gap="0.375rem"
            align="center"
          >
            <template v-if="ep.url">
              <TLink :href="ep.url" external family="mono" size="sm" :aria-label="t('webFunctions.openUrl', { url: ep.url })">
                {{ ep.url }}
              </TLink>
              <TButton
                size="sm"
                variant="ghost"
                icon-only
                :label="t('webFunctions.copyUrl', { url: ep.url })"
                :aria-label="t('webFunctions.copyUrl', { url: ep.url })"
                @click="copy(ep.url)"
              >
                <template #icon><TIcon name="copy" /></template>
              </TButton>
              <TTag v-if="ep.authType === 'IamAuth'" size="sm" variant="soft">IamAuth</TTag>
            </template>
            <TText v-else tone="muted" size="sm">{{ ep.name }} · {{ t('webFunctions.noUrl') }}</TText>
          </TStack>
        </TStack>
      </template>

      <template #cell-revisions="{ row }">
        <TText family="mono" size="sm">
          {{ (row as unknown as WebFunctionSummary).revisions.length }}
        </TText>
      </template>

      <template #cell-state="{ row }">
        <TBadge :tone="webStateTone(String(row.state))" variant="soft">
          {{ webStateLabel(String(row.state), t) }}
        </TBadge>
      </template>

      <template #cell-requests="{ row }">
        <TStack direction="horizontal" gap="0.375rem" justify="flex-end">
          <TBadge :tone="Number(row.requests) > 0 ? 'info' : 'neutral'" variant="soft">{{ row.requests }}</TBadge>
          <TBadge v-if="Number(row.errors) > 0" tone="danger" variant="soft">
            {{ t('lambdas.errShort', { count: Number(row.errors) }) }}
          </TBadge>
        </TStack>
      </template>
    </TTable>
  </TCard>
</template>
