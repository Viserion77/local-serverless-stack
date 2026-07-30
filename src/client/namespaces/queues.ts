import type { Http } from '../http';
import type {
  AwaitIdleInput,
  AwaitIdleResult,
  CapturedMessage,
  QueueSnapshot,
  ReceiveMessagesInput,
  SendMessageInput,
  SendMessageResult,
  SqsMessage,
} from '../types';

export interface QueuesApi {
  list(region?: string): Promise<QueueSnapshot[]>;
  get(name: string, region?: string): Promise<QueueSnapshot>;
  resetProcessed(name: string, region?: string): Promise<{ success: true }>;
  /** Block until the queue drains. Resolves on 200 (drained) AND 408 (timeout) — inspect `drained`. */
  awaitIdle(name: string, input?: AwaitIdleInput, region?: string): Promise<AwaitIdleResult>;
  hold(name: string, region?: string): Promise<unknown>;
  captured(name: string, region?: string): Promise<CapturedMessage[]>;
  release(name: string, region?: string): Promise<unknown>;
  send(name: string, input: SendMessageInput, region?: string): Promise<SendMessageResult>;
  receive(name: string, input?: ReceiveMessagesInput, region?: string): Promise<{ messages: SqsMessage[] }>;
  deleteMessage(name: string, receiptHandle: string, region?: string): Promise<{ success: true }>;
  purge(name: string, region?: string): Promise<{ success: true }>;
}

// Headroom on top of the server-side await-idle budget, so the 408 always wins
// the race against the client abort.
const AWAIT_IDLE_GRACE_MS = 5000;

export function createQueuesApi(http: Http, defaultRegion?: string): QueuesApi {
  const reg = (r?: string) => r ?? defaultRegion;
  const base = (name: string) => `/api/queues/${encodeURIComponent(name)}`;
  return {
    list: (r) => http.json('GET', '/api/queues', { query: { region: reg(r) } }),
    get: (name, r) => http.json('GET', base(name), { query: { region: reg(r) } }),
    resetProcessed: (name, r) =>
      http.json('POST', `${base(name)}/reset-processed`, { query: { region: reg(r) } }),
    awaitIdle: (name, input, r) =>
      http.json('POST', `${base(name)}/await-idle`, {
        body: input ?? {},
        query: { region: reg(r) },
        okStatuses: [408], // additive to 2xx: 200 = drained, 408 = timed out (inspect `drained`)
        // The server blocks for up to `timeoutMs` (its own default is 15 s,
        // clamped to 120 s) and only then answers 408. The client's shared
        // default is also 15 s, so without a longer per-request budget the
        // abort and the 408 raced — the main waiting primitive of the whole
        // test story resolved or threw depending on scheduling.
        timeoutMs: Math.min(Math.max(input?.timeoutMs ?? 15000, 100), 120000) + AWAIT_IDLE_GRACE_MS,
      }),
    hold: (name, r) => http.json('POST', `${base(name)}/hold`, { query: { region: reg(r) } }),
    captured: (name, r) => http.json('GET', `${base(name)}/captured`, { query: { region: reg(r) } }),
    release: (name, r) => http.json('POST', `${base(name)}/release`, { query: { region: reg(r) } }),
    send: (name, input, r) =>
      http.json('POST', `${base(name)}/messages`, { body: input, query: { region: reg(r) } }),
    receive: (name, input, r) =>
      http.json('POST', `${base(name)}/messages/receive`, { body: input ?? {}, query: { region: reg(r) } }),
    deleteMessage: (name, receiptHandle, r) =>
      http.json('POST', `${base(name)}/messages/delete`, {
        body: { receiptHandle },
        query: { region: reg(r) },
      }),
    purge: (name, r) => http.json('POST', `${base(name)}/purge`, { query: { region: reg(r) } }),
  };
}
