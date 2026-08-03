// A stack-wide record of what the Lambda runtime has actually been doing, so
// the dashboard can answer "how hard is this pulling my machine right now?".
//
// The per-service history in LambdaRuntimeManager cannot answer that: it is
// scoped to one service and carries the captured logs, so it is both too
// narrow and too heavy to scan across 40 services. This is the complement —
// one small, global, log-free ring of spans, cheap enough to record on every
// invocation and to serialise on every dashboard poll.
//
// Everything here is derived from spans that already happened; nothing is
// sampled on a timer, so an idle stack costs nothing at all.

export interface InvocationSpan {
  service: string;
  functionName: string;
  // Wall-clock start, and how long the handler ran. `startedAt + durationMs`
  // is the end, which is what makes overlap (parallelism) computable.
  startedAt: number;
  durationMs: number;
  ok: boolean;
  // The invocation paid for forking a worker (lazy start or post-idle wake).
  coldStart: boolean;
}

export interface ConcurrencyBucket {
  // Bucket start, and the highest number of invocations in flight at any
  // instant inside it. Peak, not average: a burst that saturates the host for
  // 200 ms is exactly what an average would hide.
  at: number;
  peak: number;
  started: number;
}

export interface ActivitySnapshot {
  windowMs: number;
  // Oldest-first, so a chart can render without re-sorting.
  spans: InvocationSpan[];
  buckets: ConcurrencyBucket[];
  totals: {
    invocations: number;
    errors: number;
    coldStarts: number;
    // Highest parallelism seen anywhere in the window, and right now.
    peakConcurrency: number;
    activeNow: number;
    avgDurationMs: number;
  };
}

// Enough to cover a busy minute across a large monorepo without becoming a
// memory story of its own: each span is a handful of numbers and two strings.
const MAX_SPANS = 1000;
const DEFAULT_WINDOW_MS = 120_000;
const DEFAULT_BUCKETS = 60;

export class InvocationActivity {
  private static instance: InvocationActivity;
  private spans: InvocationSpan[] = [];

  static getInstance(): InvocationActivity {
    if (!InvocationActivity.instance) {
      InvocationActivity.instance = new InvocationActivity();
    }
    return InvocationActivity.instance;
  }

  record(span: InvocationSpan): void {
    this.spans.push(span);
    if (this.spans.length > MAX_SPANS) {
      this.spans.splice(0, this.spans.length - MAX_SPANS);
    }
  }

  // Test seam and a way to zero the view without restarting the stack.
  reset(): void {
    this.spans = [];
  }

  /**
   * Everything the activity panel needs, computed in one pass.
   *
   * `now` is injectable so the caller (and the tests) control the window edge
   * rather than depending on wall-clock timing.
   */
  snapshot(options: { windowMs?: number; buckets?: number; now?: number } = {}): ActivitySnapshot {
    const now = options.now ?? Date.now();
    const windowMs = positive(options.windowMs, DEFAULT_WINDOW_MS);
    const bucketCount = positive(options.buckets, DEFAULT_BUCKETS);
    const from = now - windowMs;

    // A span that STARTED before the window but is still running belongs in
    // the view — it is part of the current load, which is the whole question.
    const spans = this.spans
      .filter(span => span.startedAt + span.durationMs >= from)
      .sort((a, b) => a.startedAt - b.startedAt);

    const bucketMs = windowMs / bucketCount;
    const buckets: ConcurrencyBucket[] = Array.from({ length: bucketCount }, (_, index) => ({
      at: Math.round(from + index * bucketMs),
      peak: 0,
      started: 0,
    }));

    let errors = 0;
    let coldStarts = 0;
    let totalDuration = 0;
    let activeNow = 0;

    for (const span of spans) {
      if (!span.ok) errors++;
      if (span.coldStart) coldStarts++;
      totalDuration += span.durationMs;
      const endedAt = span.startedAt + span.durationMs;
      if (span.startedAt <= now && endedAt > now) activeNow++;

      const firstBucket = clamp(Math.floor((span.startedAt - from) / bucketMs), 0, bucketCount - 1);
      const lastBucket = clamp(Math.floor((endedAt - from) / bucketMs), 0, bucketCount - 1);
      if (span.startedAt >= from) buckets[firstBucket].started++;
      // A zero-length span still occupies the instant it ran, so the range is
      // inclusive on both ends rather than a half-open interval.
      for (let index = firstBucket; index <= lastBucket; index++) {
        buckets[index].peak++;
      }
    }

    return {
      windowMs,
      spans,
      buckets,
      totals: {
        invocations: spans.length,
        errors,
        coldStarts,
        peakConcurrency: buckets.reduce((max, bucket) => Math.max(max, bucket.peak), 0),
        activeNow,
        avgDurationMs: spans.length === 0 ? 0 : Math.round(totalDuration / spans.length),
      },
    };
  }
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
