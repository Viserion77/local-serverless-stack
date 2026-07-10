import { SqsQueue } from '../../../../src/server/engine/emulators/sqs/queue.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const RETENTION = 60_000;
const recv = (queue: SqsQueue, max = 10, visibilityMs = 30_000) =>
  queue.receive({ max, visibilityMs, retentionMs: RETENTION });

describe('SqsQueue state machine', () => {
  test('send → receive → delete lifecycle with live counters', () => {
    const queue = new SqsQueue('orders');
    const outcome = queue.send({ body: 'hello world', delayMs: 0 });
    expect(outcome.messageId).toBeTruthy();
    expect(outcome.md5OfBody).toBe('5eb63bbbe01eeed093cb22bb8f5acdc3');
    expect(outcome.deduplicated).toBe(false);
    expect(outcome.sequenceNumber).toBeUndefined();
    expect(queue.counters(RETENTION)).toEqual({ available: 1, inFlight: 0, delayed: 0 });

    const [message] = recv(queue, 1);
    expect(message.body).toBe('hello world');
    expect(message.receiveCount).toBe(1);
    expect(message.receiptHandle).toBeTruthy();
    expect(queue.counters(RETENTION)).toEqual({ available: 0, inFlight: 1, delayed: 0 });

    expect(queue.deleteMessage(message.receiptHandle as string)).toBe('deleted');
    expect(queue.counters(RETENTION)).toEqual({ available: 0, inFlight: 0, delayed: 0 });
  });

  test('onVisible hook fires when a message arrives visible', () => {
    const onVisible = jest.fn();
    const queue = new SqsQueue('orders', { onVisible });
    queue.send({ body: 'a', delayMs: 0 });
    expect(onVisible).toHaveBeenCalledTimes(1);
  });

  test('delayed messages surface after the delay and fire onVisible', async () => {
    const onVisible = jest.fn();
    const queue = new SqsQueue('orders', { onVisible });
    queue.send({ body: 'later', delayMs: 80 });
    expect(queue.counters(RETENTION)).toEqual({ available: 0, inFlight: 0, delayed: 1 });
    expect(recv(queue)).toHaveLength(0);
    expect(onVisible).not.toHaveBeenCalled();

    await sleep(160);
    expect(queue.counters(RETENTION)).toEqual({ available: 1, inFlight: 0, delayed: 0 });
    expect(onVisible).toHaveBeenCalledTimes(1);
    expect(recv(queue)).toHaveLength(1);
  });

  test('visibility expiry redelivers with incremented receive count', async () => {
    const queue = new SqsQueue('orders');
    queue.send({ body: 'retry-me', delayMs: 0 });

    const [first] = recv(queue, 1, 60);
    const firstHandle = first.receiptHandle;
    const firstReceiveTs = first.firstReceiveTimestamp;
    expect(first.receiveCount).toBe(1);

    await sleep(150);
    expect(queue.counters(RETENTION)).toEqual({ available: 1, inFlight: 0, delayed: 0 });

    const [second] = recv(queue, 1, 60);
    expect(second.messageId).toBe(first.messageId);
    expect(second.receiveCount).toBe(2);
    expect(second.receiptHandle).not.toBe(firstHandle);
    expect(second.firstReceiveTimestamp).toBe(firstReceiveTs);
  });

  test('requeued message returns to its original position', async () => {
    const queue = new SqsQueue('orders');
    queue.send({ body: 'm1', delayMs: 0 });
    queue.send({ body: 'm2', delayMs: 0 });

    const [m1] = recv(queue, 1, 50);
    expect(m1.body).toBe('m1');
    await sleep(120);

    const bodies = recv(queue).map(message => message.body);
    expect(bodies).toEqual(['m1', 'm2']);
  });

  test('waitForVisible wakes on message arrival (long-poll primitive)', async () => {
    const queue = new SqsQueue('orders');
    const start = Date.now();
    const parked = queue.waitForVisible(5000);
    setTimeout(() => queue.send({ body: 'wake', delayMs: 0 }), 50);
    await parked;
    expect(Date.now() - start).toBeLessThan(1000);
    expect(recv(queue)).toHaveLength(1);
  });

  test('waitForVisible times out when nothing arrives', async () => {
    const queue = new SqsQueue('orders');
    const start = Date.now();
    await queue.waitForVisible(60);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(1000);
  });

  test('dispose wakes parked waiters', async () => {
    const queue = new SqsQueue('orders');
    const start = Date.now();
    const parked = queue.waitForVisible(5000);
    queue.dispose();
    await parked;
    expect(Date.now() - start).toBeLessThan(500);
  });

  describe('FIFO', () => {
    const fifoSend = (queue: SqsQueue, body: string, group: string, dedupId?: string) =>
      queue.send({
        body,
        delayMs: 0,
        messageGroupId: group,
        messageDeduplicationId: dedupId ?? `${group}-${body}`,
      });

    test('a group with in-flight messages yields no further messages', () => {
      const queue = new SqsQueue('orders.fifo');
      fifoSend(queue, 'A1', 'A');
      fifoSend(queue, 'A2', 'A');
      fifoSend(queue, 'B1', 'B');

      const [a1] = recv(queue, 1);
      expect(a1.body).toBe('A1');

      // Group A is locked: only B1 is deliverable.
      const rest = recv(queue);
      expect(rest.map(message => message.body)).toEqual(['B1']);
      expect(queue.hasDeliverable(RETENTION)).toBe(false);

      // Deleting A1 unlocks the group.
      expect(queue.deleteMessage(a1.receiptHandle as string)).toBe('deleted');
      expect(queue.hasDeliverable(RETENTION)).toBe(true);
      expect(recv(queue).map(message => message.body)).toEqual(['A2']);
    });

    test('group unlock via delete wakes parked pollers', async () => {
      const queue = new SqsQueue('orders.fifo');
      fifoSend(queue, 'A1', 'A');
      fifoSend(queue, 'A2', 'A');
      const [a1] = recv(queue, 1);

      const start = Date.now();
      const parked = queue.waitForVisible(5000);
      setTimeout(() => queue.deleteMessage(a1.receiptHandle as string), 50);
      await parked;
      expect(Date.now() - start).toBeLessThan(1000);
      expect(recv(queue, 1)[0].body).toBe('A2');
    });

    test('one receive can deliver a whole group batch in order', () => {
      const queue = new SqsQueue('orders.fifo');
      fifoSend(queue, 'A1', 'A');
      fifoSend(queue, 'A2', 'A');
      const batch = recv(queue);
      expect(batch.map(message => message.body)).toEqual(['A1', 'A2']);
    });

    test('visibility expiry unlocks the group again', async () => {
      const queue = new SqsQueue('orders.fifo');
      fifoSend(queue, 'A1', 'A');
      const [a1] = recv(queue, 1, 60);
      expect(a1.body).toBe('A1');
      expect(queue.hasDeliverable(RETENTION)).toBe(false);
      await sleep(140);
      expect(queue.hasDeliverable(RETENTION)).toBe(true);
      expect(recv(queue, 1)[0].receiveCount).toBe(2);
    });

    test('explicit dedup id returns the ORIGINAL message id and sequence', () => {
      const queue = new SqsQueue('orders.fifo');
      const first = queue.send({ body: 'x', delayMs: 0, messageGroupId: 'A', messageDeduplicationId: 'd-1' });
      const dup = queue.send({ body: 'x', delayMs: 0, messageGroupId: 'A', messageDeduplicationId: 'd-1' });
      expect(dup.deduplicated).toBe(true);
      expect(dup.messageId).toBe(first.messageId);
      expect(dup.sequenceNumber).toBe(first.sequenceNumber);
      expect(queue.counters(RETENTION).available).toBe(1);
    });

    test('content-based dedup hashes the body', () => {
      const queue = new SqsQueue('orders.fifo');
      const first = queue.send({ body: 'same', delayMs: 0, messageGroupId: 'A', contentBasedDeduplication: true });
      const dup = queue.send({ body: 'same', delayMs: 0, messageGroupId: 'A', contentBasedDeduplication: true });
      const other = queue.send({ body: 'different', delayMs: 0, messageGroupId: 'A', contentBasedDeduplication: true });
      expect(dup.deduplicated).toBe(true);
      expect(dup.messageId).toBe(first.messageId);
      expect(other.deduplicated).toBe(false);
      expect(queue.counters(RETENTION).available).toBe(2);
    });

    test('dedup window expires', async () => {
      const queue = new SqsQueue('orders.fifo', { dedupWindowMs: 50 });
      queue.send({ body: 'x', delayMs: 0, messageGroupId: 'A', messageDeduplicationId: 'd-1' });
      await sleep(80);
      const again = queue.send({ body: 'x', delayMs: 0, messageGroupId: 'A', messageDeduplicationId: 'd-1' });
      expect(again.deduplicated).toBe(false);
      expect(queue.counters(RETENTION).available).toBe(2);
    });

    test('sequence numbers increase monotonically', () => {
      const queue = new SqsQueue('orders.fifo');
      const first = fifoSend(queue, 'a', 'A');
      const second = fifoSend(queue, 'b', 'A');
      expect(BigInt(second.sequenceNumber as string)).toBeGreaterThan(
        BigInt(first.sequenceNumber as string),
      );
    });
  });

  test('retention prunes expired visible messages at read time', async () => {
    const queue = new SqsQueue('orders');
    queue.send({ body: 'old', delayMs: 0 });
    await sleep(80);
    expect(queue.counters(50)).toEqual({ available: 0, inFlight: 0, delayed: 0 });
    expect(queue.receive({ max: 10, visibilityMs: 1000, retentionMs: 50 })).toHaveLength(0);
  });

  test('purge drops visible, delayed and in-flight messages', () => {
    const queue = new SqsQueue('orders');
    queue.send({ body: 'visible', delayMs: 0 });
    queue.send({ body: 'delayed', delayMs: 60_000 });
    queue.send({ body: 'inflight', delayMs: 0 });
    recv(queue, 1);
    queue.purge();
    expect(queue.counters(RETENTION)).toEqual({ available: 0, inFlight: 0, delayed: 0 });
  });

  test('deleting with a stale (formerly valid) handle is a silent no-op', async () => {
    const queue = new SqsQueue('orders');
    queue.send({ body: 'x', delayMs: 0 });
    const [message] = recv(queue, 1, 40);
    const staleHandle = message.receiptHandle as string;
    await sleep(100); // handle expires; message requeued
    expect(queue.deleteMessage(staleHandle)).toBe('stale');
    expect(queue.counters(RETENTION).available).toBe(1);
  });

  test('malformed and foreign receipt handles are invalid', () => {
    const queue = new SqsQueue('orders');
    const other = new SqsQueue('other-queue');
    other.send({ body: 'x', delayMs: 0 });
    const [foreign] = other.receive({ max: 1, visibilityMs: 1000, retentionMs: RETENTION });

    expect(queue.deleteMessage('garbage-handle')).toBe('invalid');
    expect(queue.deleteMessage(foreign.receiptHandle as string)).toBe('invalid');
    expect(queue.changeVisibility('garbage-handle', 0)).toBe('invalid');
  });

  test('changeVisibility(0) requeues immediately', () => {
    const onVisible = jest.fn();
    const queue = new SqsQueue('orders', { onVisible });
    queue.send({ body: 'x', delayMs: 0 });
    const [message] = recv(queue, 1);
    const handle = message.receiptHandle as string;
    onVisible.mockClear();

    expect(queue.changeVisibility(handle, 0)).toBe('changed');
    expect(queue.counters(RETENTION)).toEqual({ available: 1, inFlight: 0, delayed: 0 });
    expect(onVisible).toHaveBeenCalled();
    // The released handle is no longer in flight.
    expect(queue.changeVisibility(handle, 1000)).toBe('not-inflight');
  });

  test('changeVisibility extends the deadline', async () => {
    const queue = new SqsQueue('orders');
    queue.send({ body: 'x', delayMs: 0 });
    const [message] = recv(queue, 1, 50);
    expect(queue.changeVisibility(message.receiptHandle as string, 60_000)).toBe('changed');
    await sleep(120);
    expect(queue.counters(RETENTION)).toEqual({ available: 0, inFlight: 1, delayed: 0 });
  });

  test('serialize/restore: in-flight becomes visible, delayed stays delayed, sequence continues', () => {
    const source = new SqsQueue('orders.fifo');
    source.send({ body: 'visible', delayMs: 0, messageGroupId: 'A', messageDeduplicationId: 'd1' });
    source.send({ body: 'delayed', delayMs: 60_000, messageGroupId: 'A', messageDeduplicationId: 'd2' });
    const sent = source.send({ body: 'inflight', delayMs: 0, messageGroupId: 'B', messageDeduplicationId: 'd3' });
    recv(source, 10); // takes 'visible' + 'inflight' into flight (groups A and B)

    const snapshot = source.serialize();
    source.dispose();

    const restored = new SqsQueue('orders.fifo');
    restored.restore(snapshot);
    // Former in-flight messages are visible again (handles died with the process).
    expect(restored.counters(RETENTION)).toEqual({ available: 2, inFlight: 0, delayed: 1 });

    // Dedup window survives the snapshot.
    const dup = restored.send({ body: 'inflight', delayMs: 0, messageGroupId: 'B', messageDeduplicationId: 'd3' });
    expect(dup.deduplicated).toBe(true);
    expect(dup.messageId).toBe(sent.messageId);

    // Sequence numbering continues past the snapshot.
    const next = restored.send({ body: 'new', delayMs: 0, messageGroupId: 'C', messageDeduplicationId: 'd4' });
    expect(BigInt(next.sequenceNumber as string)).toBeGreaterThan(BigInt(sent.sequenceNumber as string));
  });
});
