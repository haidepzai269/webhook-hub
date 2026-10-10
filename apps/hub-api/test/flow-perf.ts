/**
 * Đo hiệu năng 3 route flow (SPEC-event-flow-ui §3: topology ≤ 300ms, executions ≤ 200ms trên 10k event).
 * KHÔNG phải test jest (không có .spec): chạy tay sau khi seed tenant đo (perf-seed.sql):
 *   npx ts-node --transpile-only -r tsconfig-paths/register apps/hub-api/test/flow-perf.ts <tenantId> [eventId]
 * Gọi thẳng FlowService (cùng code route, bỏ HTTP/JWT). In p50/p95 của 20 lần sau 3 lần khởi động.
 */
import { PrismaService } from '@hub/database';
import { FlowService } from '../src/modules/flow/flow.service';

async function main() {
  const [tenant, eventId] = process.argv.slice(2);
  const svc = new PrismaService();
  const flow = new FlowService(svc);
  const cases: [string, () => Promise<unknown>][] = [
    ['topology 15m', () => flow.getTopology(tenant, '15m')],
    ['topology 24h', () => flow.getTopology(tenant, '24h')],
    ['executions (tất cả)', () => flow.listExecutions(tenant, {})],
    ['executions failed', () => flow.listExecutions(tenant, { status: 'failed' })],
    ['executions succeeded', () => flow.listExecutions(tenant, { status: 'succeeded' })],
    ['executions type=payment.*', () => flow.listExecutions(tenant, { type: 'payment.*' })],
  ];
  if (eventId) cases.push(['events/:id', () => flow.getEventFlow(tenant, eventId)]);
  for (const [name, fn] of cases) {
    for (let i = 0; i < 3; i++) await fn();
    const t: number[] = [];
    for (let i = 0; i < 20; i++) {
      const s = performance.now();
      await fn();
      t.push(performance.now() - s);
    }
    t.sort((a, b) => a - b);
    console.log(`${name.padEnd(28)} p50 ${t[9].toFixed(1)}ms  p95 ${t[18].toFixed(1)}ms`);
  }
  await svc.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
