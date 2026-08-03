<script setup lang="ts">
// "How hard is this stack pulling my machine right now?"
//
// Three answers stacked, coarse to fine:
//   1. Stat tiles — the headline numbers (resident workers against their cap,
//      peak parallelism, host memory, load).
//   2. A parallelism area over time — the shape of the load, so a burst that
//      saturated the host for 300 ms is visible instead of averaged away.
//   3. A span timeline — one row per service, one bar per invocation, so
//      *which* services overlapped is readable, not inferred.
//
// Chart-design notes, because they are decisions and not taste:
//   - Invocations are ONE colour (TreeUI's `chart-1`). Colouring 40 services
//     categorically is unreadable and the palette only has 8 slots; identity
//     lives on the row axis instead, which scales.
//   - Failures are NOT distinguished by colour alone: they get the status
//     colour AND a cross cap AND a counted, labelled stat. Red/green sits at
//     ΔE 4.4 under deuteranopia — colour alone would hide every error from a
//     colourblind reader.
//   - No dual axis: parallelism (count) and duration (ms) are two charts, not
//     two scales on one.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { TCard, TStack, TText, TStat, TGrid, TBadge, TTag, TSpinner, TToggleGroup } from '@treeui/vue';
import { api } from '../services/api';
import type { ActivitySnapshot } from '../services/api';
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

// One row per service that actually ran something in the window, newest first
// by last activity — a 40-service monorepo must not render 40 empty lanes.
const lanes = computed(() => {
  const spans = data.value?.spans ?? [];
  const byService = new Map<string, typeof spans>();
  for (const span of spans) {
    const list = byService.get(span.service) ?? [];
    list.push(span);
    byService.set(span.service, list);
  }
  return [...byService.entries()]
    .map(([service, list]) => ({
      service,
      spans: list,
      lastAt: Math.max(...list.map(s => s.startedAt + s.durationMs)),
    }))
    .sort((a, b) => b.lastAt - a.lastAt);
});

const windowStart = computed(() => {
  const buckets = data.value?.buckets ?? [];
  return buckets.length > 0 ? buckets[0].at : 0;
});
const windowEnd = computed(() => windowStart.value + (data.value?.windowMs ?? 0));

// x in 0..100 (percent of the window), so the SVG scales with its container
// instead of needing a measured pixel width.
function xPct(at: number): number {
  const span = windowEnd.value - windowStart.value || 1;
  return clamp(((at - windowStart.value) / span) * 100, 0, 100);
}

function widthPct(startedAt: number, durationMs: number): number {
  const right = xPct(startedAt + durationMs);
  // A sub-pixel span is still an event that happened: floor it at a visible
  // sliver rather than rendering nothing.
  return Math.max(right - xPct(startedAt), 0.4);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// The parallelism area, as an SVG polygon over the bucket series. Step-shaped
// on purpose: concurrency is a count that changes at instants, and a smoothed
// curve would draw parallelism that never existed.
const CHART_HEIGHT = 64;
const concurrencyPath = computed(() => {
  const buckets = data.value?.buckets ?? [];
  if (buckets.length === 0) return '';
  const peak = Math.max(1, ...buckets.map(b => b.peak));
  const step = 100 / buckets.length;
  const points: string[] = ['0,' + CHART_HEIGHT];
  buckets.forEach((bucket, index) => {
    const y = CHART_HEIGHT - (bucket.peak / peak) * CHART_HEIGHT;
    points.push(`${(index * step).toFixed(2)},${y.toFixed(2)}`);
    points.push(`${((index + 1) * step).toFixed(2)},${y.toFixed(2)}`);
  });
  points.push('100,' + CHART_HEIGHT);
  return points.join(' ');
});

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
        <TText v-if="error" tone="muted" size="sm">⚠ {{ error }}</TText>

        <TGrid :columns="4" gap="0.75rem">
          <TStat
            :label="t('activity.workersWarm')"
            :value="`${residency?.warm ?? 0} / ${residency?.maxWarmWorkers ?? 0}`"
            :hint="t('activity.workersWarmHint')"
          />
          <TStat
            :label="t('activity.peakConcurrency')"
            :value="String(totals?.peakConcurrency ?? 0)"
            :hint="t('activity.peakConcurrencyHint')"
          />
          <TStat
            :label="t('activity.hostMemory')"
            :value="`${memoryUsedPct}%`"
            :hint="t('activity.hostMemoryHint', {
              used: formatBytes((host?.totalMemBytes ?? 0) - (host?.freeMemBytes ?? 0)),
              total: formatBytes(host?.totalMemBytes),
            })"
          />
          <TStat
            :label="t('activity.hostLoad')"
            :value="`${loadPct}%`"
            :hint="t('activity.hostLoadHint', {
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
          <TBadge v-if="(totals?.errors ?? 0) > 0" tone="danger" variant="soft">
            ✕ {{ t('activity.errors', { count: totals?.errors ?? 0 }) }}
          </TBadge>
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
            <svg
              :viewBox="`0 0 100 ${CHART_HEIGHT}`"
              preserveAspectRatio="none"
              role="img"
              :aria-label="t('activity.parallelismAria', { peak: peakLabel })"
              style="width: 100%; height: 64px"
            >
              <polygon
                :points="concurrencyPath"
                fill="var(--tree-color-chart-1)"
                fill-opacity="0.28"
                stroke="var(--tree-color-chart-1)"
                stroke-width="2"
                vector-effect="non-scaling-stroke"
              />
            </svg>
          </TStack>

          <!-- Span timeline: identity on the row axis, so it scales past the
               8 categorical slots a per-service colouring would need. -->
          <TStack direction="vertical" gap="0.25rem">
            <TText size="sm" weight="semibold">{{ t('activity.timeline') }}</TText>
            <TStack
              v-for="lane in lanes"
              :key="lane.service"
              direction="horizontal"
              gap="0.5rem"
              align="center"
            >
              <TText size="sm" tone="muted" family="mono" style="min-width: 9rem">{{ lane.service }}</TText>
              <svg
                viewBox="0 0 100 10"
                preserveAspectRatio="none"
                role="img"
                :aria-label="t('activity.laneAria', { service: lane.service, count: lane.spans.length })"
                style="width: 100%; height: 14px"
              >
                <rect x="0" y="4" width="100" height="2" fill="var(--tree-color-border-default)" />
                <g v-for="(span, index) in lane.spans" :key="index">
                  <rect
                    :x="xPct(span.startedAt)"
                    y="1"
                    :width="widthPct(span.startedAt, span.durationMs)"
                    height="8"
                    rx="1"
                    :fill="span.ok ? 'var(--tree-color-chart-1)' : 'var(--tree-color-status-error)'"
                  >
                    <title>{{ spanTitle(span) }}</title>
                  </rect>
                  <!-- Failures carry a shape, not just a hue: red/green is
                       indistinguishable to a deuteranopic reader. -->
                  <path
                    v-if="!span.ok"
                    :d="`M ${xPct(span.startedAt)} 0 L ${xPct(span.startedAt) + 1.2} 10`"
                    stroke="var(--tree-color-status-error)"
                    stroke-width="2"
                    vector-effect="non-scaling-stroke"
                  />
                </g>
              </svg>
            </TStack>
            <TStack direction="horizontal" justify="space-between">
              <TText size="sm" tone="muted">{{ t('activity.axisStart', { value: formatMs(data?.windowMs) }) }}</TText>
              <TText size="sm" tone="muted">{{ t('activity.axisNow') }}</TText>
            </TStack>
          </TStack>

          <!-- Identity is never colour-alone: the resident workers are also a
               plain list, which doubles as the table view of the chart. -->
          <TStack v-if="warmWorkers.length" direction="horizontal" gap="0.5rem" wrap>
            <TTag v-for="worker in warmWorkers" :key="worker.service" size="sm" variant="soft">
              {{ worker.service }} · {{ t('activity.workerPid', { pid: worker.pid ?? 0 }) }}
            </TTag>
          </TStack>
        </template>
      </template>
    </TStack>
  </TCard>
</template>
