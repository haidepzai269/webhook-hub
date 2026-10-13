import { HUB_CLEANUP_SUGGESTED, validateCanonical } from '@hub/common';
import { StorageJob } from '../src/scheduler/storage.job';
import { cleanupSuggestionsRejected, cleanupAdvisorFailOpen } from '../src/metrics';

/**
 * QT4b (SPEC-han-muc-dung-luong §5.6, ADR-187) trong StorageJob: advisor -> hàng rào -> lưu; webhook
 * `hub.project.cleanup_suggested` đi QUA OUTBOX BÌNH THƯỜNG (events + delivery + outbox `delivery.requested`).
 */
const T = 't-qt4b';
const MB = 1048576;
const NOW = Date.parse('2026-10-12T12:00:00Z');
const BUCKETS = [
  { sourceId: null, importance: 'low', ageDays: 4, events: 100, bytes: 8 * MB },
  { sourceId: null, importance: 'junk', ageDays: 2, events: 10, bytes: 40_000 },
];

function fake(o: { usage?: any; subs?: any[] } = {}) {
  const st = { saved: [] as any[][], events: [] as any[], deliveries: [] as any[], outbox: [] as any[], marked: [] as number[], txs: 0 };
  const redis: any = { set: jest.fn(async () => 'OK'), on: jest.fn(), quit: jest.fn(async () => 'OK') };
  const repo = (inTx: boolean) => ({
    findStoragePolicies: jest.fn(async () => [{ importance: 'low', action: 'trim', afterDays: 3, trigger: 'always' }]),
    findKeepLongerSourceIds: jest.fn(async () => []),
    trafficBytesSince: jest.fn(async () => 2 * MB),
    saveStorageSuggestions: jest.fn(async (s: any[]) => st.saved.push(s)),
    findProjectUsage: jest.fn(async () => o.usage ?? { suggestedAt: null, suggestedBytes: null, bloatFactor: 2, suggestions: [], byBucket: BUCKETS }),
    markCleanupSuggestedEmitted: jest.fn(async (b: number) => {
      if (!inTx) throw new Error('đánh dấu phải cùng transaction với event');
      st.marked.push(b);
    }),
    createEvent: jest.fn(async (e: any) => {
      if (!inTx) throw new Error('event phải trong transaction');
      st.events.push(e);
      return e;
    }),
    findActiveSubscriptionsForEvent: jest.fn(async () => o.subs ?? [{ id: 'sub-1', destinationId: 'd-1', destination: { id: 'd-1', name: 'ops', type: 'webhook', verification: 'VERIFIED' } }]),
    createDelivery: jest.fn(async (d: any) => {
      st.deliveries.push(d);
      return { id: `del-${st.deliveries.length}`, ...d };
    }),
  });
  const prisma: any = {
    forTenant: jest.fn((_t: string, tx?: unknown) => repo(!!tx)),
    tenantTx: jest.fn(async (_t: string, fn: (tx: any) => Promise<unknown>) => {
      st.txs++;
      return fn({ outbox: { create: jest.fn(async ({ data }: any) => st.outbox.push(data)) } });
    }),
  };
  const job = new StorageJob(prisma, redis);
  job.clock = () => NOW;
  return { job, st, prisma };
}

const metric = async (c: typeof cleanupSuggestionsRejected, advisor: string) => (await c.get()).values.find((v) => v.labels.advisor === advisor)?.value ?? 0;

describe('QT4b: gợi ý dọn trong StorageJob + webhook qua outbox', () => {
  it('[QT:T22] (phần b) advisor giả trả gợi ý mức Cao / olderThan quá mới / số MB bịa -> bị loại hoặc tính lại TRƯỚC khi lưu; metric hub_cleanup_suggestions_rejected_total{advisor} tăng', async () => {
    const { job, st } = fake();
    job.advisor = {
      id: 'evil@1',
      suggest: async () => [
        { action: 'delete', importance: ['high'], olderThan: '3d', sourceId: null, advisor: 'evil@1', reason: 'x', reasonCode: 'x' },
        { action: 'trim', importance: ['low'], olderThan: '30m', sourceId: null, advisor: 'evil@1', reason: 'x', reasonCode: 'x' },
        { action: 'trim', importance: ['low'], olderThan: '3d', sourceId: null, advisor: 'evil@1', reason: 'x', reasonCode: 'x', estimatedBytes: 1e12, estimatedEvents: 1 },
      ] as never,
    };
    const before = await metric(cleanupSuggestionsRejected, 'evil@1');
    const out = await job.refreshSuggestions(T, { usedBytes: 20 * MB, quotaBytes: 50 * MB, level: 'OK', bloatFactor: 2, buckets: BUCKETS as any, emitIfChanged: false });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ importance: ['low'], estimatedEvents: 100, estimatedBytes: Math.round(8 * MB * 0.9), advisor: 'evil@1' });
    expect(st.saved).toEqual([out]);
    expect((await metric(cleanupSuggestionsRejected, 'evil@1')) - before).toBe(2);
  });

  it('[QT:T23] (phần b) advisor ném lỗi -> fail-open về rules@1, lượt vẫn lưu gợi ý; metric fail-open tăng', async () => {
    const { job, st } = fake();
    job.advisor = { id: 'llm@1', suggest: async () => Promise.reject(new Error('LLM sập')) };
    const before = await metric(cleanupAdvisorFailOpen as any, 'llm@1');
    const out = await job.refreshSuggestions(T, { usedBytes: 20 * MB, quotaBytes: 50 * MB, level: 'OK', bloatFactor: 2, buckets: BUCKETS as any, emitIfChanged: false });
    expect(out.map((s) => s.advisor)).toEqual(['rules@1', 'rules@1']);
    expect(st.saved).toHaveLength(1);
    expect((await metric(cleanupAdvisorFailOpen as any, 'llm@1')) - before).toBe(1);
  });

  it('[QT:T24] (phần c) nấc LÊN (kể cả LOCKED) -> MỘT event hub.project.cleanup_suggested qua outbox bình thường: events (source hub) + delivery PENDING + outbox delivery.requested + đánh dấu cùng transaction; data khớp catalog', async () => {
    const { job, st } = fake({
      usage: {
        suggestedAt: new Date(NOW - 60_000), // vừa phát 1 phút trước — nấc lên vẫn phát
        suggestedBytes: 1,
        bloatFactor: 2,
        byBucket: BUCKETS,
        suggestions: [{ action: 'trim', importance: ['low'], olderThan: '3d', sourceId: null, advisor: 'rules@1', reason: 'r', reasonCode: 'delivered_old' }],
      },
    });
    await job.reportLevelChange({ tenantId: T, from: 'CRITICAL_95', to: 'LOCKED', usedBytes: 51 * MB, quotaBytes: 50 * MB });
    expect(st.events).toHaveLength(1);
    const e = st.events[0];
    expect(e).toMatchObject({ type: HUB_CLEANUP_SUGGESTED, source: 'hub', sourceId: null, origin: 'derived', normalized: true });
    expect(e.idempotencyKey).toBe(`hub:${e.id}`);
    expect(validateCanonical(e.type, e.data)).toEqual({ ok: true });
    expect(e.data).toMatchObject({ level: 'LOCKED', usedBytes: 51 * MB, quotaBytes: 50 * MB, forecastHours: 0 });
    expect(e.data.suggestions[0]).toMatchObject({ importance: ['low'], estimatedBytes: Math.round(8 * MB * 0.9) });
    expect(st.deliveries).toEqual([expect.objectContaining({ eventId: e.id, subscriptionId: 'sub-1', status: 'PENDING', attemptGeneration: 1 })]);
    expect(st.outbox).toEqual([expect.objectContaining({ topic: 'delivery.requested' })]);
    expect(st.marked).toEqual([Math.round(8 * MB * 0.9)]);
    expect(st.txs).toBe(1);
  });

  it('[BP:T5] (phần a) event hub.* qua emitHubEvent -> outbox delivery.requested mang gợi ý destinationId + rateLimitRps (một chỗ điền: route-event.ts, SPEC-BP C1)', async () => {
    const { job, st } = fake({
      usage: {
        suggestedAt: null,
        suggestedBytes: 1,
        bloatFactor: 2,
        byBucket: BUCKETS,
        suggestions: [{ action: 'trim', importance: ['low'], olderThan: '3d', sourceId: null, advisor: 'rules@1', reason: 'r', reasonCode: 'delivered_old' }],
      },
      subs: [{ id: 'sub-1', destinationId: 'd-1', destination: { id: 'd-1', name: 'ops', type: 'webhook', verification: 'VERIFIED', rateLimitRps: 7 } }],
    });
    await job.reportLevelChange({ tenantId: T, from: 'CRITICAL_95', to: 'LOCKED', usedBytes: 51 * MB, quotaBytes: 50 * MB });
    expect(st.outbox).toHaveLength(1);
    expect(st.outbox[0].payload).toMatchObject({ deliveryId: 'del-1', tenantId: T, destinationId: 'd-1', rateLimitRps: 7, attemptCount: 0 });
  });

  it('[QT:T24] (phần d) nấc XUỐNG không phát; OK + không gợi ý không phát; đổi ít / đã phát trong ngày không phát', async () => {
    const down = fake();
    await down.job.reportLevelChange({ tenantId: T, from: 'LOCKED', to: 'WARN_85', usedBytes: 40 * MB, quotaBytes: 50 * MB });
    expect(down.st.events).toHaveLength(0);
    const empty = fake();
    expect(await empty.job.emitCleanupSuggested(T, { levelRose: false, level: 'OK', usedBytes: 1, quotaBytes: 50 * MB, suggestions: [] })).toBe(false);
    const recent = fake({ usage: { suggestedAt: new Date(NOW - 3_600_000), suggestedBytes: 0, bloatFactor: 2, suggestions: [], byBucket: BUCKETS } });
    const out = await recent.job.refreshSuggestions(T, { usedBytes: 30 * MB, quotaBytes: 50 * MB, level: 'WARN_70', bloatFactor: 2, buckets: BUCKETS as any, emitIfChanged: true });
    expect(out.length).toBeGreaterThan(0);
    expect(recent.st.events).toHaveLength(0);
    // > 24h và đổi ≥ 10% quota -> phát (reason changed)
    const changed = fake({ usage: { suggestedAt: new Date(NOW - 25 * 3_600_000), suggestedBytes: 0, bloatFactor: 2, suggestions: [], byBucket: BUCKETS } });
    await changed.job.refreshSuggestions(T, { usedBytes: 30 * MB, quotaBytes: 50 * MB, level: 'WARN_70', bloatFactor: 2, buckets: BUCKETS as any, emitIfChanged: true });
    expect(changed.st.events).toHaveLength(1);
  });

  it('đích webhook chưa VERIFIED không nhận event của hub (cùng luật S6 với mọi event — một đường định tuyến)', async () => {
    const { job, st } = fake({ subs: [{ id: 's', destinationId: 'd', destination: { id: 'd', name: 'x', type: 'webhook', verification: 'PENDING' } }] });
    await job.reportLevelChange({ tenantId: T, from: 'OK', to: 'WARN_70', usedBytes: 36 * MB, quotaBytes: 50 * MB });
    expect(st.events).toHaveLength(1);
    expect(st.deliveries).toHaveLength(0);
    expect(st.outbox).toHaveLength(0);
  });
});
