export interface DemoQueueCrontab {
  run: string;
  check: string;
  expire: string;
}

export interface DemoQueueOverviewItem {
  queueId: number;
  namespace: string;
  hookUrl: string;
  concurrency: number;
  waiting: number;
  running: number;
  available: number;
  utilization: number;
  retrying: number;
  deadLetters: number;
  oldestWaitingAt: string | null;
  oldestWaitingAgeSeconds: number | null;
  callbacks: { success: number; failure: number };
  claims: { claimed: number; recovered: number };
  crontab: DemoQueueCrontab;
  updatedAt: string;
}

export interface DemoQueueOverview {
  generatedAt: string;
  metricsStartedAt: string;
  summary: {
    queueCount: number;
    waiting: number;
    running: number;
    capacity: number;
    utilization: number;
    retrying: number;
    deadLetters: number;
    oldestWaitingAt: string;
    oldestWaitingAgeSeconds: number;
    callbackSuccesses: number;
    callbackFailures: number;
    claims: number;
    recovered: number;
  };
  queues: DemoQueueOverviewItem[];
}

export interface DemoDeadLetterItem {
  entryId: string;
  taskId: string;
  retryCount: number;
  failedAt: string;
  reason: 'callback_failed' | 'lease_expired';
}

export interface DemoDeadLetterPage {
  total: number;
  offset: number;
  limit: number;
  items: DemoDeadLetterItem[];
}

export const DEMO_SNAPSHOT_AT = '2026-08-11T11:04:43.000Z';

export const DEMO_OVERVIEW: DemoQueueOverview = {
  generatedAt: DEMO_SNAPSHOT_AT,
  metricsStartedAt: '2026-08-11T08:01:16.000Z',
  summary: {
    queueCount: 3,
    waiting: 12,
    running: 4,
    capacity: 10,
    utilization: 40,
    retrying: 2,
    deadLetters: 5,
    oldestWaitingAt: '2026-08-11T07:32:43.000Z',
    oldestWaitingAgeSeconds: 12_720,
    callbackSuccesses: 72,
    callbackFailures: 6,
    claims: 78,
    recovered: 3,
  },
  queues: [
    {
      queueId: 1,
      namespace: 'billing-export',
      hookUrl: 'https://worker.example.invalid/billing/callback',
      concurrency: 5,
      waiting: 12,
      running: 4,
      available: 1,
      utilization: 80,
      retrying: 2,
      deadLetters: 0,
      oldestWaitingAt: '2026-08-11T07:32:43.000Z',
      oldestWaitingAgeSeconds: 12_720,
      callbacks: { success: 42, failure: 2 },
      claims: { claimed: 44, recovered: 1 },
      crontab: { run: '*/2 * * * * *', check: '*/10 * * * * *', expire: '0 */5 * * * *' },
      updatedAt: '2026-08-11T10:56:00.000Z',
    },
    {
      queueId: 2,
      namespace: 'media-transcode',
      hookUrl: 'https://media.example.invalid/transcode/callback',
      concurrency: 3,
      waiting: 0,
      running: 0,
      available: 3,
      utilization: 0,
      retrying: 0,
      deadLetters: 0,
      oldestWaitingAt: null,
      oldestWaitingAgeSeconds: null,
      callbacks: { success: 21, failure: 0 },
      claims: { claimed: 21, recovered: 0 },
      crontab: { run: '*/5 * * * * *', check: '*/10 * * * * *', expire: '0 */5 * * * *' },
      updatedAt: '2026-08-11T10:52:00.000Z',
    },
    {
      queueId: 3,
      namespace: 'partner-sync',
      hookUrl: 'https://partner.example.invalid/sync/callback',
      concurrency: 2,
      waiting: 0,
      running: 0,
      available: 2,
      utilization: 0,
      retrying: 0,
      deadLetters: 5,
      oldestWaitingAt: null,
      oldestWaitingAgeSeconds: null,
      callbacks: { success: 9, failure: 4 },
      claims: { claimed: 13, recovered: 2 },
      crontab: { run: '* * * * * *', check: '*/10 * * * * *', expire: '0 */5 * * * *' },
      updatedAt: '2026-08-11T10:58:00.000Z',
    },
  ],
};

const DEMO_DEAD_LETTERS: Record<number, DemoDeadLetterItem[]> = {
  3: [
    { entryId: 'demo-01', taskId: 'partner-sync-20260811-041', retryCount: 3, failedAt: '2026-08-11T10:49:12.000Z', reason: 'callback_failed' },
    { entryId: 'demo-02', taskId: 'partner-sync-20260811-037', retryCount: 3, failedAt: '2026-08-11T10:41:08.000Z', reason: 'callback_failed' },
    { entryId: 'demo-03', taskId: 'partner-sync-20260811-029', retryCount: 2, failedAt: '2026-08-11T10:25:44.000Z', reason: 'lease_expired' },
    { entryId: 'demo-04', taskId: 'partner-sync-20260811-018', retryCount: 3, failedAt: '2026-08-11T10:04:20.000Z', reason: 'callback_failed' },
    { entryId: 'demo-05', taskId: 'partner-sync-20260811-012', retryCount: 2, failedAt: '2026-08-11T09:53:07.000Z', reason: 'lease_expired' },
  ],
};

export function demoDeadLetters(queueId: number, offset: number, limit: number): DemoDeadLetterPage {
  const items = DEMO_DEAD_LETTERS[queueId] ?? [];
  return { total: items.length, offset, limit, items: items.slice(offset, offset + limit) };
}
