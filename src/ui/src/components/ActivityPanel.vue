<script setup lang="ts">
// "How hard is this stack pulling my machine right now?"
//
// Three answers stacked, coarse to fine:
//   1. Stat tiles — the headline numbers (resident workers against their cap,
//      peak parallelism, host memory, load).
//   2. A parallelism area over time — the shape of the load, so a burst that
//      saturated the host for 300 ms is visible instead of averaged away.
//   3. A span timeline — one row per lambda, one bar per invocation, so
//      *which* handlers overlapped is readable, not inferred.
//
// Both plots are TreeUI primitives (TREEUX-003, delivered in 0.29). Until then
// this file drew its own SVG and carried the product's only three inline
// styles — `TChart interpolation="step"` and `TSpanLanes` express exactly what
// those hand-rolled polygons did, so the rule-2 exception table lost all three
// of its ActivityPanel rows rather than gaining a fourth.
//
// Chart-design notes, because they are decisions and not taste:
//   - Invocations are ONE colour (TreeUI's `chart-1`, which is both `TChart`'s
//     first series and an untoned `TSpanLanes` span, so neither plot needs a
//     colour override). Colouring 40 services categorically is unreadable and
//     the palette only has 8 slots; identity lives on the row axis instead,
//     which scales.
//   - Parallelism is a STEP area, never a curve. Concurrency is a count that
//     holds its value across a bucket and then jumps; `linear` and `smooth`
//     both INTERPOLATE, drawing parallelism that never existed. `step` is also
//     why the series is now one point per bucket: the old polygon emitted two
//     points at the same `y` to fake the riser, which the primitive draws.
//   - Failures are NOT distinguished by colour alone: they get the status
//     colour AND a cross in the lane's `marker` slot AND a counted, labelled
//     stat. Red/green sits at ΔE 4.4 under deuteranopia — colour alone would
//     hide every error from a colourblind reader.
//   - No dual axis: parallelism (count) and duration (ms) are two charts, not
//     two scales on one.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  TCard, TStack, TText, TStat, TGrid, TBadge, TTag, TIcon, TSpinner, TToggleGroup, TChart, TSpanLanes,
} from '@treeui/vue';
import type { TChartSeries, TSpan, TSpanLane } from '@treeui/vue';
import { api } from '../services/api';
import type { ActivitySnapshot, InvocationSpan } from '../services/api';
import { useI18n } from '../i18n';

const { t } = useI18n();

const data = ref<ActivitySnapshot | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const windowMs = ref(120_000);
let timer: number | null = null;

const windowOptions = computed(() => [
  { value: '60000', label: t('activity.window1m') },
  { value: '120000', label: t('activity.window2m') },
  { value: '600000', label: t('activity.window10m') },
]);
const windowValue = computed({
  get: () => String(windowMs.value),
  set: (value: string) => {
    windowMs.value = Number(value);
    void load();
  },
});

async function load(): Promise<void> {
  try {
    data.value = await api.getActivity(windowMs.value);
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('activity.loadFailed');
  } finally {
    loading.value = false;
  }
}

// ---- derived view models --------------------------------------------------

const totals = computed(() => data.value?.totals);
const residency = computed(() => data.value?.residency);
const host = computed(() => data.value?.host);

const memoryUsedPct = computed(() => {
  const h = host.value;
  if (!h || !h.totalMemBytes) return 0;
  return Math.round(((h.totalMemBytes - h.freeMemBytes) / h.totalMemBytes) * 100);
});

// Load average is per-core; normalising by CPU count is what makes "1.5" mean
// something on a 2-core laptop and on a 32-core workstation alike.
const loadPct = computed(() => {
  const h = host.value;
  if (!h || !h.cpuCount) return 0;
  return Math.round((h.loadAvg1m / h.cpuCount) * 100);
});

const warmWorkers = computed(() => (data.value?.workers ?? []).filter(w => w.warm));

// "Which lambdas are up?" — the question the worker list alone cannot answer.
// A worker is one process serving many functions, each loaded into its module
// cache on ITS first invocation, so a warm service can be holding one handler
// or sixty. These are the handlers actually resident right now; everything else
// the service declares costs nothing until it is called.
const residentWorkers = computed(() => warmWorkers.value.map(worker => ({
  ...worker,
  // Most recently loaded first: in a long session the tail is the history and
  // the head is what is being worked on.
  resident: [...worker.loadedFunctions].reverse(),
})));

const windowStart = computed(() => {
  const buckets = data.value?.buckets ?? [];
  return buckets.length > 0 ? buckets[0].at : 0;
});
const windowEnd = computed(() => windowStart.value + (data.value?.windowMs ?? 0));

// One row per FUNCTION that ran, newest first by last activity.
//
// It used to be one row per service, which answered a question nobody opens
// this panel to ask: a service owning 60 lambdas drew a single lane labelled
// "billing-service", and *which* lambda fired stayed invisible. The service is
// the unit of PROCESS (see the resident-worker list below); the function is the
// unit of work, and this is the work chart.
//
// The label is the short function name, because that is the identifier being
// looked for and the lane label ellipsises. A name that is ambiguous — the same
// short name in two services — is the only one that gets qualified, so the
// common case stays readable and the ambiguous case stays correct.
// `description` is what `TSpanLanes` puts on the lane's `aria-label`, so the
// service and the count stay available without seeing a single bar.
const lanes = computed<TSpanLane[]>(() => {
  const byFunction = new Map<string, InvocationSpan[]>();
  for (const span of data.value?.spans ?? []) {
    const key = `${span.service}::${span.functionName}`;
    const list = byFunction.get(key) ?? [];
    list.push(span);
    byFunction.set(key, list);
  }
  const owners = new Map<string, Set<string>>();
  for (const [, list] of byFunction) {
    const services = owners.get(list[0].functionName) ?? new Set<string>();
    services.add(list[0].service);
    owners.set(list[0].functionName, services);
  }
  return [...byFunction.values()]
    .map(list => ({ list, lastAt: Math.max(...list.map(s => s.startedAt + s.durationMs)) }))
    .sort((a, b) => b.lastAt - a.lastAt)
    .map(({ list }) => {
      const { service, functionName } = list[0];
      const ambiguous = (owners.get(functionName)?.size ?? 0) > 1;
      return {
        label: ambiguous ? `${service}/${functionName}` : functionName,
        description: t('activity.laneAria', { function: functionName, service, count: list.length }),
        spans: list.map(toSpan),
      };
    });
});

function toSpan(span: InvocationSpan): TSpan {
  return {
    start: span.startedAt,
    end: span.startedAt + span.durationMs,
    // `default` is the one invocation hue (chart-1); only failure earns a
    // second colour, and even then it never travels alone — see the marker.
    tone: span.ok ? 'default' : 'danger',
    title: spanTitle(span),
  };
}

// Lane geometry. 14px keeps a long list scannable — worth noting that the row
// count is now bounded by the lambdas that RAN in the window, not by the 40
// services that exist, so a busy 2-minute window is a taller chart than the
// per-service version ever was. The marker is sized to the bar rather than the
// lane (`TSpanLanes` insets each span 2px inside its track), so the cross reads
// on a hairline span instead of swamping the row.
const LANE_HEIGHT = 14;
const LANE_MARKER_SIZE = 10;

// A lane budget, because this panel draws one row per FUNCTION that ran: at the
// target scale (40 services, ~60 functions each) a ten-minute window can produce
// well over a hundred lanes, and the panel is a summary, not a log. 12 rows is
// ~170px, which keeps the timeline the same visual weight as the plot above it.
//
// Cutting with `.slice()` here would hide data without saying so, which is worse
// than a long list — so the cut is TSpanLanes' own `maxRows`, which forces a
// footer declaring how many lanes were left out. `overflowLabel` is what routes
// that footer through t(); without it the component falls back to English on
// purpose, so the count can never silently disappear.
const MAX_LANES = 12;

function lanesOverflowLabel(hidden: number): string {
  return t('activity.lanesOverflow', { hidden: String(hidden) });
}

// The parallelism area: one point per bucket, held flat by `interpolation`.
const CHART_HEIGHT = 64;
const concurrencySeries = computed<TChartSeries[]>(() => [{
  name: t('activity.parallelism'),
  data: (data.value?.buckets ?? []).map(bucket => bucket.peak),
}]);

// Category labels for the buckets. They never render (the window is already
// labelled once, under the lanes, for both plots) but they are what the hover
// tooltip and the chart's visually-hidden data table call each column — "#37"
// is not an answer to "when did that burst happen?".
const bucketLabels = computed(() => (data.value?.buckets ?? [])
  .map(bucket => t('activity.axisStart', { value: formatMs(windowEnd.value - bucket.at) })));

const peakLabel = computed(() => Math.max(1, ...(data.value?.buckets ?? []).map(b => b.peak)));

function formatBytes(bytes: number | undefined): string {
  if (!bytes) return '—';
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function formatMs(ms: number | undefined): string {
  if (ms === undefined) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

function spanTitle(span: { functionName: string; durationMs: number; ok: boolean; coldStart: boolean }): string {
  const parts = [span.functionName, formatMs(span.durationMs)];
  if (!span.ok) parts.push(t('activity.failed'));
  if (span.coldStart) parts.push(t('activity.coldStart'));
  return parts.join(' · ');
}

onMounted(() => {
  void load();
  // 5s: fast enough to watch a pipeline run, slow enough to cost nothing.
  timer = window.setInterval(load, 5000);
});

onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer);
});
</script>

<template>
  <TCard variant="outline">
    <template #header>
      <TStack direction="horizontal" gap="0.75rem" align="center" justify="space-between" wrap>
        <TStack direction="horizontal" gap="0.5rem" align="center" wrap>
          <TText weight="semibold">{{ t('activity.title') }}</TText>
          <TBadge :tone="(totals?.activeNow ?? 0) > 0 ? 'success' : 'neutral'" variant="soft">
            {{ t('activity.inFlight', { count: totals?.activeNow ?? 0 }) }}
          </TBadge>
        </TStack>
        <TToggleGroup v-model="windowValue" :options="windowOptions" size="sm" />
      </TStack>
    </template>

    <TStack direction="vertical" gap="1rem">
      <TText tone="muted" size="sm">{{ t('activity.description') }}</TText>

      <TStack v-if="loading" direction="horizontal" justify="center">
        <TSpinner :label="t('common.loading')" />
      </TStack>

      <template v-else>
        <TStack v-if="error" direction="horizontal" gap="0.375rem" align="center">
          <TIcon name="triangle-alert" />
          <TText tone="muted" size="sm">{{ error }}</TText>
        </TStack>

        <!-- The second line of each tile is `meta`, not `hint`: TStat has no
             `hint` prop and sets `inheritAttrs: false`, so what looked like a
             caption was an attribute the component dropped on the floor — three
             languages of copy that never reached a pixel. -->
        <!-- Five tiles, not four: `minItemWidth` keeps them wrapping instead of
             shrinking, so the extra unit (handlers, next to processes) does not
             squeeze the row on a narrow window. -->
        <TGrid :columns="5" min-item-width="12rem" gap="0.75rem">
          <TStat
            :label="t('activity.workersWarm')"
            :value="`${residency?.warm ?? 0} / ${residency?.maxWarmWorkers ?? 0}`"
            :meta="t('activity.workersWarmHint')"
          />
          <!-- The number that scales with a real monorepo: 1024 registered
               lambdas cost nothing until they are called, and this says how
               many are actually being paid for. -->
          <TStat
            :label="t('activity.functionsLoaded')"
            :value="`${residency?.loadedFunctions ?? 0} / ${residency?.registeredFunctions ?? 0}`"
            :meta="t('activity.functionsLoadedHint')"
          />
          <TStat
            :label="t('activity.peakConcurrency')"
            :value="String(totals?.peakConcurrency ?? 0)"
            :meta="t('activity.peakConcurrencyHint')"
          />
          <TStat
            :label="t('activity.hostMemory')"
            :value="`${memoryUsedPct}%`"
            :meta="t('activity.hostMemoryHint', {
              used: formatBytes((host?.totalMemBytes ?? 0) - (host?.freeMemBytes ?? 0)),
              total: formatBytes(host?.totalMemBytes),
            })"
          />
          <TStat
            :label="t('activity.hostLoad')"
            :value="`${loadPct}%`"
            :meta="t('activity.hostLoadHint', {
              load: (host?.loadAvg1m ?? 0).toFixed(2),
              cpus: host?.cpuCount ?? 0,
            })"
          />
        </TGrid>

        <TStack direction="horizontal" gap="0.75rem" align="center" wrap>
          <TTag size="sm" variant="soft">{{ t('activity.stackRss', { value: formatBytes(host?.rssBytes) }) }}</TTag>
          <TTag size="sm" variant="soft">{{ t('activity.invocations', { count: totals?.invocations ?? 0 }) }}</TTag>
          <TTag size="sm" variant="soft">{{ t('activity.avgDuration', { value: formatMs(totals?.avgDurationMs) }) }}</TTag>
          <TTag v-if="(totals?.coldStarts ?? 0) > 0" size="sm" variant="soft">
            {{ t('activity.coldStarts', { count: totals?.coldStarts ?? 0 }) }}
          </TTag>
          <!-- One row, one component. This counter used to be a TBadge purely
               because TTag had no colour axis; 0.27 gave TTag `tone`, so the
               failure count keeps its red without breaking the row's shape.
               The cross moves into the `#icon` slot — TTag hides that slot from
               assistive tech, which is right: "3 failed" already says it in
               words, and the mark is the non-chromatic signal for a reader who
               cannot separate the red from the neutrals. -->
          <TTag v-if="(totals?.errors ?? 0) > 0" size="sm" variant="soft" tone="danger">
            <template #icon>
              <TIcon name="x" />
            </template>
            {{ t('activity.errors', { count: totals?.errors ?? 0 }) }}
          </TTag>
        </TStack>

        <template v-if="(totals?.invocations ?? 0) === 0">
          <TText tone="muted" size="sm">{{ t('activity.empty') }}</TText>
        </template>

        <template v-else>
          <!-- Parallelism over the window. One series, so no legend: the
               heading names it and the peak is direct-labeled. -->
          <TStack direction="vertical" gap="0.25rem">
            <TStack direction="horizontal" justify="space-between" wrap>
              <TText size="sm" weight="semibold">{{ t('activity.parallelism') }}</TText>
              <TText size="sm" tone="muted">{{ t('activity.peakLabel', { peak: peakLabel }) }}</TText>
            </TStack>
            <!-- No axes and no grid: 64px of plot has no room for ticks, the
                 peak is direct-labeled above and the window is labeled below.
                 `ariaLabel` becomes the caption of the data table TChart keeps
                 for screen readers, which is strictly more than the old
                 `role="img"` polygon offered. `seriesLabel` localises that
                 table's column header — it was hardcoded "Series", the one
                 string in this trilingual panel that no t() could reach. -->
            <TChart
              type="area"
              interpolation="step"
              :series="concurrencySeries"
              :labels="bucketLabels"
              :height="CHART_HEIGHT"
              :show-grid="false"
              :show-x-axis="false"
              :show-y-axis="false"
              :series-label="t('activity.chartSeriesLabel')"
              :aria-label="t('activity.parallelismAria', { peak: peakLabel })"
            />
          </TStack>

          <!-- Span timeline: identity on the row axis, so it scales past the
               8 categorical slots a per-lane colouring would need. -->
          <TStack direction="vertical" gap="0.25rem">
            <TText size="sm" weight="semibold">{{ t('activity.timeline') }}</TText>
            <!-- `minSpanPercent` is left at the library default (0.4%), which
                 is the exact floor this panel used to apply by hand: a 3 ms
                 invocation in a 60 s window is an event that happened, and a
                 zero-width rectangle would deny it. -->
            <TSpanLanes
              :rows="lanes"
              :from="windowStart"
              :to="windowEnd"
              :lane-height="LANE_HEIGHT"
              :max-rows="MAX_LANES"
              :overflow-label="lanesOverflowLabel"
              :label="t('activity.timeline')"
            >
              <!-- The lane label is already sized, muted and ellipsised by the
                   component; the only thing the product adds is mono, because
                   a function name is an identifier. -->
              <template #label="{ row }">
                <TText family="mono">{{ row.label }}</TText>
              </template>
              <!-- Failures carry a shape, not just a hue: red/green is
                   indistinguishable to a deuteranopic reader. The cross is
                   decorative (no `label`) on purpose — the span's own title and
                   the counted "N failed" tag already say it in words. -->
              <template #marker="{ span }">
                <TIcon v-if="span.tone === 'danger'" name="x" :size="LANE_MARKER_SIZE" />
              </template>
            </TSpanLanes>
            <TStack direction="horizontal" justify="space-between">
              <TText size="sm" tone="muted">{{ t('activity.axisStart', { value: formatMs(data?.windowMs) }) }}</TText>
              <TText size="sm" tone="muted">{{ t('activity.axisNow') }}</TText>
            </TStack>
          </TStack>

          <!-- Identity is never colour-alone: the resident workers are also a
               plain list, which doubles as the table view of the chart. Each
               one now names the handlers it is actually holding — the process
               is the cost, the handlers inside it are the answer to "which
               lambda is up?". -->
          <TStack v-if="residentWorkers.length" direction="vertical" gap="0.5rem">
            <TText size="sm" weight="semibold">{{ t('activity.resident') }}</TText>
            <TStack
              v-for="worker in residentWorkers"
              :key="worker.service"
              direction="horizontal"
              gap="0.5rem"
              align="center"
              wrap
            >
              <TTag size="sm" variant="soft">
                {{ worker.service }} · {{ t('activity.workerPid', { pid: worker.pid ?? 0 }) }}
              </TTag>
              <TTag
                v-for="fn in worker.resident"
                :key="fn"
                size="sm"
                variant="soft"
                tone="success"
              >
                {{ fn }}
              </TTag>
              <!-- A forked worker with nothing loaded is a real state, not a
                   rendering gap: it was woken by a registration or is still
                   booting, and it is holding memory for zero handlers. -->
              <TText v-if="worker.resident.length === 0" size="sm" tone="muted">
                {{ t('activity.residentNone') }}
              </TText>
            </TStack>
          </TStack>
        </template>
      </template>
    </TStack>
  </TCard>
</template>
