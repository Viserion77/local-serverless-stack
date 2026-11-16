<script setup lang="ts">
// One wiring diagram on TreeUI's `TCanvasSurface`: the toolbar (zoom, fit,
// Download SVG), the canvas, the hover strip, and — inside the canvas, where
// the browser exposes it to assistive technology and never paints it — the
// same connections as a `TTable`. Shared by the service detail card and the
// stack map page, so both screens draw with one code path.
//
// Nothing here touches the canvas API (the ESLint reason is at the top of
// `graphLayout.ts`): the pixels live in `graphCanvas.ts`, the geometry in
// `graphLayout.ts`, the SVG in `graphSvg.ts`. This file wires them to Vue and
// to TreeUI and writes no CSS.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { TButton, TCanvasSurface, TIcon, TStack, TTable, TTag, TText } from '@treeui/vue';
import type { GraphEdgeKind, GraphNode } from '../../services/api';
import { graphNodeIcons } from '../../icons/resourceIcons';
import { useI18n } from '../../i18n';
import type { GraphInput } from './graphLayout';
import { layoutGraph } from './graphLayout';
import { createGraphView, downloadSvg, readPalette, watchTheme } from './graphCanvas';
import type { Palette } from './graphCanvas';
import { createGraphText, nodeSubtitle } from './graphText';
import type { NodeCounter } from './graphText';
import { renderGraphSvg } from './graphSvg';

const props = withDefaults(defineProps<{
  graph: GraphInput | null;
  // Accessible name of the drawing and `<title>` of the exported SVG.
  title: string;
  filename: string;
  height?: number | string;
  counters?: ReadonlyMap<string, NodeCounter>;
  // Frame headers collapse their service (stack map only).
  collapsible?: boolean;
  hint?: string;
}>(), {
  height: 480,
  counters: () => new Map(),
  collapsible: false,
  hint: '',
});

const emit = defineEmits<{
  activate: [node: GraphNode];
  frame: [group: string];
}>();

const { t, locale } = useI18n();
const surface = ref<InstanceType<typeof TCanvasSurface> | null>(null);
const cursor = ref('grab');
const hovered = ref<GraphNode | null>(null);
const palette = shallowRef<Palette | null>(null);

const layout = computed(() => (props.graph ? layoutGraph(props.graph) : null));
const text = computed(() => {
  void locale.value;
  return createGraphText(t, props.counters, props.collapsible);
});

const view = createGraphView({
  onActivate: node => emit('activate', node),
  onHover: node => { hovered.value = node; },
  onFrame: group => emit('frame', group),
  onCursor: next => { cursor.value = next; },
  requestRedraw: () => surface.value?.redraw(),
  toPoint: event => surface.value?.point(event) ?? null,
});

// The surface calls this on mount, on resize and on every `redraw()`.
const draw = view.draw;

watch([layout, text, palette], () => {
  if (palette.value) view.setLayout(layout.value, text.value, palette.value);
}, { immediate: true });

let stopTheme: (() => void) | null = null;
onMounted(() => {
  palette.value = readPalette();
  stopTheme = watchTheme(() => { palette.value = readPalette(); });
});
onBeforeUnmount(() => stopTheme?.());

// The export is the DECLARED architecture: no live counters (a snapshot of one
// session's traffic would date the file the moment it is saved) and no
// "collapse" hint (nothing in a file can be clicked).
function download(): void {
  if (!layout.value || !palette.value) return;
  downloadSvg(renderGraphSvg(layout.value, palette.value, createGraphText(t, new Map(), false), props.title), props.filename);
}

// The accessible equivalent: every connector, in words.
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
const columns = computed(() => [
  { key: 'source', label: t('services.graphColSource') },
  { key: 'link', label: t('services.graphColLink') },
  { key: 'target', label: t('services.graphColTarget') },
]);
const rows = computed(() => {
  const nodes = new Map((props.graph?.nodes ?? []).map(node => [node.id, node]));
  return (props.graph?.edges ?? []).map(edge => ({
    id: edge.id,
    source: nodes.get(edge.from)?.label ?? edge.from,
    target: nodes.get(edge.to)?.label ?? edge.to,
    link: [kindLabels.value[edge.kind] ?? edge.kind, edge.via ? kindLabels.value[edge.via] : '', edge.detail ?? '']
      .filter(Boolean).join(' · '),
  }));
});
</script>

<template>
  <TStack direction="vertical" gap="0.5rem">
    <TStack direction="horizontal" gap="0.5rem" align="center" justify="space-between" wrap>
      <TStack direction="horizontal" gap="0.5rem" align="center" wrap>
        <template v-if="hovered">
          <TTag size="sm" variant="soft">
            <template #icon><TIcon :name="graphNodeIcons[hovered.kind]" /></template>
            {{ hovered.label }}
          </TTag>
          <TText size="sm" tone="muted">{{ nodeSubtitle(hovered, t) }}</TText>
        </template>
        <TText v-else size="sm" tone="muted">{{ hint }}</TText>
      </TStack>
      <TStack direction="horizontal" gap="0.25rem" align="center">
        <TButton icon-only size="sm" variant="ghost" :label="t('graph.zoomOut')" @click="view.zoomBy(1 / 1.25)">
          <template #icon><TIcon name="minus" /></template>
        </TButton>
        <TButton icon-only size="sm" variant="ghost" :label="t('graph.zoomIn')" @click="view.zoomBy(1.25)">
          <template #icon><TIcon name="plus" /></template>
        </TButton>
        <TButton icon-only size="sm" variant="ghost" :label="t('graph.fit')" @click="view.fit()">
          <template #icon><TIcon name="maximize-2" /></template>
        </TButton>
        <TButton size="sm" variant="outline" :disabled="!layout" @click="download">
          <template #icon><TIcon name="download" /></template>
          {{ t('graph.downloadSvg') }}
        </TButton>
      </TStack>
    </TStack>

    <!--
      Focusable, so the arrow keys walk the cards (Enter opens one, Escape
      clears, +/-/0 zoom). No `aria-label`: with one, the surface takes
      `role="img"`, whose children are presentational — and the table inside
      IS the accessible form of this drawing.
    -->
    <TCanvasSurface
      ref="surface"
      :draw="draw"
      :height="height"
      :cursor="cursor"
      tabindex="0"
      @pointerdown="view.onPointerDown"
      @pointermove="view.onPointerMove"
      @pointerup="view.onPointerUp"
      @pointerleave="view.onPointerLeave"
      @wheel="view.onWheel"
      @keydown="view.onKeyDown"
    >
      <TTable :columns="columns" :rows="rows" row-key="id" size="sm" :aria-label="`${title} — ${t('graph.tableLabel')}`" />
    </TCanvasSurface>
  </TStack>
</template>
