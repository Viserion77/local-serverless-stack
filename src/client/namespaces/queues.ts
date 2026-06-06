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
