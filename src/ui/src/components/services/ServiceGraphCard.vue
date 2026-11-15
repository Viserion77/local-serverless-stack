<script setup lang="ts">
// The service's wiring, on one screen: which of its declared resources talk to
// which, and on what evidence.
//
// Two views of the SAME data, side by side under a tab strip, and that is a
// deliberate accessibility decision rather than a feature: a canvas is opaque
// to assistive technology, and `ui-ux.md` rule 6 makes accessibility part of
// the component. TChart solves this by always emitting a visually-hidden table;
// hiding one here would need CSS the product is not allowed to write, so the
// table is a peer tab instead — visible, keyboard-navigable, translated, and
// useful to sighted users too, because "which links exist" is easier to read as
// a list than to trace as a curve.
//
// The drawing itself is `../graph/GraphDiagram.vue` (TreeUI's TCanvasSurface,
// shared with the stack map page). It also carries the same connections as a
// table inside the canvas, for assistive technology.
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import {
  TAlert, TBadge, TCard, TCheckbox, TEmptyState, TIcon, TSpinner, TStack, TTab,
  TTabList, TTabPanel, TTable, TTabs, TText,
} from '@treeui/vue';
import { api } from '../../services/api';
import type { GraphEdgeKind, GraphNode, ServiceGraph } from '../../services/api';
import { graphNodeIcons } from '../../icons/resourceIcons';
import { useI18n } from '../../i18n';
import GraphDiagram from '../graph/GraphDiagram.vue';

const props = defineProps<{ serviceName: string }>();
const router = useRouter();
const { t } = useI18n();

const graph = ref<ServiceGraph | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const tab = ref('diagram');

// Every edge kind starts visible. Hiding one is a user action, so the diagram
// never opens having silently dropped something — the lesson TREEUX-017 records
// about budgets that truncate without saying so.
const hiddenKinds = ref<Set<GraphEdgeKind>>(new Set());

// Computed, not a module const: `t()` is only reactive at call time, so a label
// resolved once in setup would keep the language it was mounted in.
const kindLabels = computed<Record<GraphEdgeKind, string>>(() => ({
  'http-route': t('services.graphKindHttpRoute'),
  authorizer: t('services.graphKindAuthorizer'),
  'event-source': t('services.graphKindEventSource'),
  's3-notification': t('services.graphKindS3Notification'),
  'event-rule-target': t('services.graphKindEventRuleTarget'),
  'event-bus-rule': t('services.graphKindEventBusRule'),
  'sns-subscription': t('services.graphKindSnsSubscription'),
  redrive: t('services.graphKindRedrive'),
  iam: t('services.graphKindIam'),
  env: t('services.graphKindEnv'),
  'cross-service': t('graph.kindCrossService'),
}));

const nodesById = computed(() => new Map((graph.value?.nodes ?? []).map(node => [node.id, node])));

const columns = computed(() => [
  { key: 'source', label: t('services.graphColSource') },
  { key: 'link', label: t('services.graphColLink') },
  { key: 'target', label: t('services.graphColTarget') },
  { key: 'evidence', label: t('services.graphColEvidence') },
]);

const rows = computed(() => (graph.value?.edges ?? [])
  .filter(edge => !hiddenKinds.value.has(edge.kind))
  .map(edge => ({
    id: edge.id,
    source: nodesById.value.get(edge.from)?.label ?? edge.from,
    sourceKind: nodesById.value.get(edge.from)?.kind ?? 'external',
    target: nodesById.value.get(edge.to)?.label ?? edge.to,
    targetKind: nodesById.value.get(edge.to)?.kind ?? 'external',
    link: kindLabels.value[edge.kind],
    detail: edge.detail ?? '',
    confidence: edge.confidence,
    serviceWide: edge.serviceWide === true,
  })));

const visibleEdgeCount = computed(() => rows.value.length);

/**
 * Where a node leads. Only the kinds this dashboard has a screen for are
 * clickable — an EventBridge rule, an SNS topic and the execution role have no
 * detail page, and a link that goes nowhere is worse than no link.
 */
function routeFor(node: GraphNode): string | null {
  switch (node.kind) {
    case 'lambda': return `/lambdas/${encodeURIComponent(node.label)}`;
    case 'dynamodb': return `/dynamo/${encodeURIComponent(node.label)}`;
    case 'sqs': return `/queues/${encodeURIComponent(node.label)}`;
    case 's3': return `/buckets/${encodeURIComponent(node.label)}`;
    case 'opensearch': return `/opensearch/${encodeURIComponent(node.label)}`;
    case 'secret': return '/secrets';
    case 'route':
    case 'api': return '/apis';
    default: return null;
  }
}

function activate(node: GraphNode): void {
  const to = routeFor(node);
  if (to) router.push(to);
}

function toggleKind(kind: GraphEdgeKind, shown: boolean): void {
  const next = new Set(hiddenKinds.value);
  if (shown) next.delete(kind);
  else next.add(kind);
  hiddenKinds.value = next;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    graph.value = await api.getServiceGraph(props.serviceName);
    error.value = null;
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : t('services.graphFailed');
    graph.value = null;
  } finally {
    loading.value = false;
  }
}

// What the diagram draws: the payload minus the kinds the user switched off.
const drawn = computed(() => (graph.value
  ? { nodes: graph.value.nodes, edges: graph.value.edges.filter(edge => !hiddenKinds.value.has(edge.kind)) }
  : null));

watch(() => props.serviceName, load, { immediate: true });

defineExpose({ reload: load });
</script>

<template>
  <TCard variant="outline">
    <template #header>
      <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between">
        <TStack direction="horizontal" gap="0.5rem" align="center">
          <TText weight="semibold">{{ t('services.graphTitle') }}</TText>
          <TBadge v-if="graph" tone="neutral" variant="soft">
            {{ t('services.graphCounts', { nodes: graph.nodes.length, edges: visibleEdgeCount }) }}
          </TBadge>
        </TStack>
      </TStack>
    </template>

    <TStack direction="vertical" gap="0.75rem">
      <TText tone="muted" size="sm">{{ t('services.graphDescription') }}</TText>

      <TAlert v-if="error" variant="danger" dismissible @dismiss="error = null">
        {{ error }}
      </TAlert>

      <!--
        The builder's own findings, surfaced rather than swallowed: a reference
        that pointed at nothing is the reason an expected arrow is missing, and
        a diagram that omits it silently is the failure this whole payload was
        written to avoid.
      -->
      <TAlert v-if="graph?.warnings.length" variant="warning">
        <TStack direction="vertical" gap="0.125rem">
          <TText size="sm" weight="semibold">{{ t('services.graphWarnings') }}</TText>
          <TText v-for="warning in graph.warnings" :key="warning" size="sm" family="mono">
            {{ warning }}
          </TText>
        </TStack>
      </TAlert>

      <TStack v-if="loading && !graph" direction="horizontal" justify="center" align="center">
        <TSpinner :label="t('services.graphLoading')" />
      </TStack>

      <TEmptyState
        v-else-if="graph && !graph.edges.length"
        :title="t('services.graphEmptyTitle')"
        :description="t('services.graphEmptyDescription')"
      />

      <template v-else-if="graph">
        <!--
          One checkbox per kind that actually occurs. `graph.edgeKinds` is built
          by the server for exactly this: a toggle for a kind with no edges
          would be a control that does nothing.
        -->
        <TStack direction="horizontal" gap="0.75rem" wrap align="center">
          <TText size="sm" tone="muted">{{ t('services.graphFilterLabel') }}</TText>
          <TCheckbox
            v-for="kind in graph.edgeKinds"
            :key="kind"
            size="sm"
            :label="kindLabels[kind]"
            :model-value="!hiddenKinds.has(kind)"
            @update:model-value="(value: boolean) => toggleKind(kind, value)"
          />
        </TStack>

        <TTabs v-model="tab">
          <TTabList>
            <TTab value="diagram">{{ t('services.graphTabDiagram') }}</TTab>
            <TTab value="table">{{ t('services.graphTabTable') }}</TTab>
          </TTabList>

          <TTabPanel value="diagram">
            <GraphDiagram
              :graph="drawn"
              :title="t('services.graphAriaLabel', { name: serviceName, nodes: graph.nodes.length, edges: visibleEdgeCount })"
              :filename="`${serviceName}-wiring.svg`"
              :height="560"
              :hint="t('graph.hint')"
              @activate="activate"
            />
          </TTabPanel>

          <TTabPanel value="table">
            <TTable
              :columns="columns"
              :rows="rows"
              row-key="id"
              size="sm"
              :aria-label="t('services.graphTableLabel', { name: serviceName })"
            >
              <template #cell-source="{ row }">
                <TStack direction="horizontal" gap="0.375rem" align="center">
                  <TIcon :name="graphNodeIcons[row.sourceKind as GraphNode['kind']]" />
                  <TText size="sm">{{ row.source }}</TText>
                </TStack>
              </template>
              <template #cell-target="{ row }">
                <TStack direction="horizontal" gap="0.375rem" align="center">
                  <TIcon :name="graphNodeIcons[row.targetKind as GraphNode['kind']]" />
                  <TText size="sm">{{ row.target }}</TText>
                </TStack>
              </template>
              <template #cell-link="{ row }">
                <TStack direction="vertical" gap="0.125rem">
                  <TText size="sm">{{ row.link }}</TText>
                  <TText v-if="row.detail" size="xs" tone="muted" family="mono">{{ row.detail }}</TText>
                </TStack>
              </template>
              <!--
                The evidence column is the honest one. `inferred` means LSS
                matched a name and could be wrong; `service-wide` means the
                variable is on every function of the service and therefore says
                nothing about this one. Both are words, not shades.
              -->
              <template #cell-evidence="{ row }">
                <TStack direction="horizontal" gap="0.25rem" align="center" wrap>
                  <TBadge :tone="row.confidence === 'declared' ? 'success' : 'neutral'" variant="soft">
                    {{ row.confidence === 'declared'
                      ? t('services.graphEvidenceDeclared')
                      : t('services.graphEvidenceInferred') }}
                  </TBadge>
                  <TBadge v-if="row.serviceWide" tone="warning" variant="soft">
                    {{ t('services.graphServiceWide') }}
                  </TBadge>
                </TStack>
              </template>
            </TTable>
          </TTabPanel>
        </TTabs>
      </template>
    </TStack>
  </TCard>
</template>
