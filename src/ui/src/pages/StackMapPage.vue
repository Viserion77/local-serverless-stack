<script setup lang="ts">
// The stack map: every registered service on one architecture diagram
// (`GET /api/stack/graph`), cross-service references resolved into links.
//
// Expand/collapse is per service, both from the checkbox row (the accessible
// control) and on the canvas itself (click a collapsed service to expand it, a
// frame title to collapse it). With more than 8 services the server opens the
// map collapsed; the page only remembers an explicit choice.
//
// Live counters are what LSS ALREADY serves, polled on the same 10 s cadence
// as the graph: invocations/errors from `GET /api/lambdas/activity`, queue
// depth from the queue inspector. Two requests per tick for the whole stack —
// no timer per resource, which is the scale target (40 services × 60 functions).
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { TAlert, TBadge, TButton, TCard, TCheckbox, TEmptyState, TSpinner, TStack, TText } from '@treeui/vue';
import { api } from '../services/api';
import type { GraphNode, StackGraph } from '../services/api';
import { useI18n } from '../i18n';
import GraphDiagram from '../components/graph/GraphDiagram.vue';
import type { NodeCounter } from '../components/graph/graphText';

const router = useRouter();
const { t } = useI18n();

const stack = ref<StackGraph | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
// null → the server's default; a list → exactly those services expanded.
const expanded = ref<string[] | null>(null);
const counters = ref<ReadonlyMap<string, NodeCounter>>(new Map());
// Activity window the call counters cover.
const ACTIVITY_WINDOW_MS = 15 * 60 * 1000;

async function load(): Promise<void> {
  try {
    stack.value = await api.getStackGraph(expanded.value ?? undefined);
    error.value = null;
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : t('graph.stackFailed');
  } finally {
    loading.value = false;
  }
  void loadCounters();
}

// Best effort: a counter that fails to load is a missing badge, not an error.
async function loadCounters(): Promise<void> {
  const graph = stack.value;
  if (!graph) return;
  const [activity, queues] = await Promise.all([
    api.getActivity(ACTIVITY_WINDOW_MS).catch(() => null),
    api.listQueues().catch(() => null),
  ]);
  const calls = new Map<string, { calls: number; errors: number }>();
  for (const span of activity?.spans ?? []) {
    const key = `${span.service}\u0000${span.functionName}`;
    const entry = calls.get(key) ?? { calls: 0, errors: 0 };
    entry.calls += 1;
    if (!span.ok) entry.errors += 1;
    calls.set(key, entry);
  }
  const depth = new Map((queues ?? []).map(queue => [queue.name, queue.available + queue.inFlight]));
  const next = new Map<string, NodeCounter>();
  for (const node of graph.nodes) {
    if (node.kind === 'lambda') {
      const entry = calls.get(`${node.group}\u0000${node.label}`);
      if (!entry) continue;
      next.set(node.id, entry.errors
        ? { text: t(entry.errors === 1 ? 'graph.counterErrorsOne' : 'graph.counterErrors', { n: entry.errors }), tone: 'danger' }
        : { text: t(entry.calls === 1 ? 'graph.counterInvocationsOne' : 'graph.counterInvocations', { n: entry.calls }), tone: 'muted' });
    } else if (node.kind === 'sqs') {
      const queued = depth.get(node.label);
      if (queued) next.set(node.id, { text: t(queued === 1 ? 'graph.counterQueuedOne' : 'graph.counterQueued', { n: queued }), tone: 'muted' });
    }
  }
  counters.value = next;
}

function setExpanded(names: string[]): void {
  expanded.value = names;
  void load();
}

function toggle(name: string, on: boolean): void {
  const current = new Set(stack.value?.expanded ?? []);
  if (on) current.add(name);
  else current.delete(name);
  setExpanded([...current].sort());
}

const drawnNodes = computed(() => stack.value?.nodes.filter(node => node.kind !== 'route').length ?? 0);

/** Where a card leads; a collapsed service expands in place instead. */
function activate(node: GraphNode): void {
  const name = encodeURIComponent(node.label);
  switch (node.kind) {
    case 'service': toggle(node.label, true); return;
    case 'lambda': void router.push(`/lambdas/${name}`); return;
    case 'dynamodb': void router.push(`/dynamo/${name}`); return;
    case 'sqs': void router.push(`/queues/${name}`); return;
    case 's3': void router.push(`/buckets/${name}`); return;
    case 'opensearch': void router.push(`/opensearch/${name}`); return;
    case 'secret': void router.push('/secrets'); return;
    case 'api':
    case 'route': void router.push('/apis'); return;
    default:
      if (node.group && node.group !== 'external') void router.push(`/services/${encodeURIComponent(node.group)}`);
  }
}

let timer: number | undefined;
onMounted(() => {
  void load();
  timer = window.setInterval(load, 10000);
});
onBeforeUnmount(() => window.clearInterval(timer));
</script>

<template>
  <TCard variant="outline">
    <template #header>
      <TStack direction="horizontal" gap="0.75rem" align="center" justify="space-between" wrap>
        <TStack direction="horizontal" gap="0.5rem" align="center">
          <TText weight="semibold">{{ t('graph.stackTitle') }}</TText>
          <TBadge v-if="stack" tone="neutral" variant="soft">
            {{ t('graph.stackCounts', { services: stack.services.length, nodes: drawnNodes, edges: stack.edges.length }) }}
          </TBadge>
        </TStack>
        <TStack v-if="stack?.services.length" direction="horizontal" gap="0.25rem">
          <TButton size="sm" variant="ghost" @click="setExpanded(stack.services.map(s => s.name))">
            {{ t('graph.stackExpandAll') }}
          </TButton>
          <TButton size="sm" variant="ghost" @click="setExpanded([])">{{ t('graph.stackCollapseAll') }}</TButton>
        </TStack>
      </TStack>
    </template>

    <TStack direction="vertical" gap="0.75rem">
      <TText tone="muted" size="sm">{{ t('graph.stackDescription') }}</TText>

      <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">{{ error }}</TAlert>

      <TStack v-if="loading && !stack" direction="horizontal" justify="center" align="center">
        <TSpinner :label="t('graph.stackLoading')" />
      </TStack>

      <TEmptyState
        v-else-if="stack && !stack.services.length"
        :title="t('graph.stackEmptyTitle')"
        :description="t('graph.stackEmptyDescription')"
      >
        <template #actions>
          <TButton to="/onboarding" variant="solid">{{ t('graph.stackOnboarding') }}</TButton>
        </template>
      </TEmptyState>

      <template v-else-if="stack">
        <TStack direction="horizontal" gap="0.75rem" align="center" wrap>
          <TText size="sm" tone="muted">{{ t('graph.stackServices') }}</TText>
          <TCheckbox
            v-for="service in stack.services"
            :key="service.name"
            size="sm"
            :label="service.name"
            :model-value="service.expanded"
            @update:model-value="(value: boolean) => toggle(service.name, value)"
          />
        </TStack>
        <TText v-if="expanded === null && stack.services.length > 8" size="sm" tone="muted">
          {{ t('graph.stackCollapsedNote') }}
        </TText>

        <TAlert v-if="stack.warnings.length" variant="warning">
          <TStack direction="vertical" gap="0.125rem">
            <TText size="sm" weight="semibold">{{ t('graph.stackWarnings') }}</TText>
            <TText v-for="warning in stack.warnings" :key="warning" size="sm" family="mono">{{ warning }}</TText>
          </TStack>
        </TAlert>

        <GraphDiagram
          :graph="stack"
          :title="t('graph.stackTitle')"
          filename="stack-map.svg"
          height="max(560px, calc(100vh - 320px))"
          :counters="counters"
          :hint="t('graph.hintStack')"
          collapsible
          @activate="activate"
          @frame="(group: string) => toggle(group, false)"
        />
      </template>
    </TStack>
  </TCard>
</template>
