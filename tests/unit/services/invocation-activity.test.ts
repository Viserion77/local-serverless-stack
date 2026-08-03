// The stack-wide invocation ring behind the Overview activity panel. What must
// hold: parallelism is measured as a PEAK (an average hides the burst that
// actually saturates the host), a span still running counts as load even if it
// started before the window, and the buffer can never grow without bound.
import { InvocationActivity } from '../../../src/server/services/invocation-activity';
import type { InvocationSpan } from '../../../src/server/services/invocation-activity';

const NOW = 1_800_000_000_000;

function span(overrides: Partial<InvocationSpan> = {}): InvocationSpan {
  return {
    service: 'orders',
    functionName: 'createOrder',
    startedAt: NOW - 1000,
    durationMs: 100,
    ok: true,
    coldStart: false,
    ...overrides,
  };
}

let activity: InvocationActivity;

beforeEach(() => {
  activity = InvocationActivity.getInstance();
  activity.reset();
});

describe('singleton', () => {
  it('hands back the same ring to every caller', () => {
    expect(InvocationActivity.getInstance()).toBe(activity);
  });
});

describe('snapshot window', () => {
  it('keeps spans inside the window, oldest first', () => {
    activity.record(span({ startedAt: NOW - 500, functionName: 'b' }));
    activity.record(span({ startedAt: NOW - 5000, functionName: 'a' }));
    const { spans } = activity.snapshot({ windowMs: 10_000, now: NOW });
    expect(spans.map(s => s.functionName)).toEqual(['a', 'b']);
  });

  it('drops a span that finished before the window opened', () => {
    activity.record(span({ startedAt: NOW - 60_000, durationMs: 10 }));
    expect(activity.snapshot({ windowMs: 10_000, now: NOW }).spans).toEqual([]);
  });

  it('keeps a long span that started before the window but is still running', () => {
    // Exactly the case that matters: a 5-minute handler is the load, and a
    // naive "startedAt >= from" filter would report an idle stack.
    activity.record(span({ startedAt: NOW - 300_000, durationMs: 400_000 }));
    const snap = activity.snapshot({ windowMs: 10_000, now: NOW });
    expect(snap.spans).toHaveLength(1);
    expect(snap.totals.activeNow).toBe(1);
  });

  it('falls back to the defaults for missing, zero, negative or non-finite options', () => {
    activity.record(span());
    for (const bad of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const snap = activity.snapshot({ windowMs: bad as number, buckets: bad as number, now: NOW });
      expect(snap.windowMs).toBe(120_000);
      expect(snap.buckets).toHaveLength(60);
    }
  });

  it('defaults `now` to the clock when the caller does not pin it', () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(NOW);
    activity.record(span());
    expect(activity.snapshot({ windowMs: 10_000 }).spans).toHaveLength(1);
    // …and with no options at all, which is how a caller asking for "the
    // default view" invokes it.
    expect(activity.snapshot().windowMs).toBe(120_000);
    clock.mockRestore();
  });
});

describe('concurrency', () => {
  it('reports the PEAK overlap in a bucket, not how many started in it', () => {
    // Three handlers running at the same instant, one starting later.
    for (let i = 0; i < 3; i++) {
      activity.record(span({ startedAt: NOW - 9000, durationMs: 500, functionName: `f${i}` }));
    }
    activity.record(span({ startedAt: NOW - 1000, durationMs: 100, functionName: 'later' }));
    const snap = activity.snapshot({ windowMs: 10_000, buckets: 10, now: NOW });
    expect(snap.totals.peakConcurrency).toBe(3);
    const busiest = snap.buckets.reduce((a, b) => (b.peak > a.peak ? b : a));
    expect(busiest).toMatchObject({ peak: 3, started: 3 });
  });

  it('spreads a span across every bucket it overlaps', () => {
    // 4s span over 1s buckets: it is in flight for four of them.
    activity.record(span({ startedAt: NOW - 9000, durationMs: 4000 }));
    const snap = activity.snapshot({ windowMs: 10_000, buckets: 10, now: NOW });
    expect(snap.buckets.filter(b => b.peak > 0)).toHaveLength(5);
  });

  it('counts a zero-length invocation in the instant it ran', () => {
    activity.record(span({ startedAt: NOW - 5000, durationMs: 0 }));
    const snap = activity.snapshot({ windowMs: 10_000, buckets: 10, now: NOW });
    expect(snap.buckets.filter(b => b.peak > 0)).toHaveLength(1);
  });

  it('clamps a span that overruns the window edges into the first and last bucket', () => {
    activity.record(span({ startedAt: NOW - 500_000, durationMs: 600_000 }));
    const snap = activity.snapshot({ windowMs: 10_000, buckets: 10, now: NOW });
    expect(snap.buckets.every(b => b.peak === 1)).toBe(true);
    // It did not START in the window, so no bucket claims it as a start.
    expect(snap.buckets.every(b => b.started === 0)).toBe(true);
  });

  it('activeNow ignores spans that already finished', () => {
    activity.record(span({ startedAt: NOW - 5000, durationMs: 100 }));
    expect(activity.snapshot({ windowMs: 10_000, now: NOW }).totals.activeNow).toBe(0);
  });
});

describe('totals', () => {
  it('counts errors, cold starts and the mean duration', () => {
    activity.record(span({ durationMs: 100 }));
    activity.record(span({ durationMs: 300, ok: false }));
    activity.record(span({ durationMs: 200, coldStart: true }));
    const { totals } = activity.snapshot({ windowMs: 10_000, now: NOW });
    expect(totals).toMatchObject({
      invocations: 3, errors: 1, coldStarts: 1, avgDurationMs: 200,
    });
  });

  it('is all zeros on an idle stack', () => {
    const { totals, spans } = activity.snapshot({ windowMs: 10_000, now: NOW });
    expect(spans).toEqual([]);
    expect(totals).toEqual({
      invocations: 0, errors: 0, coldStarts: 0, peakConcurrency: 0, activeNow: 0, avgDurationMs: 0,
    });
  });
});

describe('bounded memory', () => {
  it('never holds more than the cap, keeping the newest spans', () => {
    for (let i = 0; i < 1200; i++) {
      activity.record(span({ startedAt: NOW - 1200 + i, durationMs: 1, functionName: `f${i}` }));
    }
    const snap = activity.snapshot({ windowMs: 600_000, now: NOW });
    expect(snap.spans).toHaveLength(1000);
    expect(snap.spans[0].functionName).toBe('f200');
  });
});
