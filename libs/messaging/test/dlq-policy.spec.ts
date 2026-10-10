import { readFileSync } from 'fs';
import { join } from 'path';
import { DLQ_POLICY, QUEUES, RETRY_TIERS } from '../src/topology';

/**
 * Review SPEC-1 (thấp), ADR-052: DLQ broker có giới hạn bằng POLICY (không đổi arguments của queue
 * đang tồn tại -> tránh PRECONDITION_FAILED). Nguồn sự thật DLQ là Postgres (deliveries DEAD).
 */
describe('DLQ_POLICY', () => {
  const re = new RegExp(DLQ_POLICY.pattern);

  it('pattern khớp ĐÚNG hai DLQ, không khớp queue nào khác', () => {
    expect(re.test(QUEUES.DELIVERY_DLQ)).toBe(true);
    expect(re.test(QUEUES.NORMALIZE_DLQ)).toBe(true);
    for (const q of [QUEUES.NORMALIZE, QUEUES.NORMALIZE_RETRY, QUEUES.DELIVERY_MAIN, ...RETRY_TIERS.map((t) => t.queueName)]) {
      expect(re.test(q)).toBe(false);
    }
    expect(re.test('q.delivery.dlq.x')).toBe(false);
  });

  it('định nghĩa: max-length + drop-head, áp cho queues', () => {
    expect(DLQ_POLICY.definition).toEqual({ 'max-length': 5000, overflow: 'drop-head' });
    expect(DLQ_POLICY.applyTo).toBe('queues');
  });

  it('docker-compose (rabbitmq-init) đặt đúng policy này — không lệch giá trị', () => {
    const compose = readFileSync(join(__dirname, '../../../docker-compose.yml'), 'utf8');
    expect(compose).toContain(`name=${DLQ_POLICY.name}`);
    // compose nội suy `$` -> trong file viết `$$`
    expect(compose).toContain(`pattern='${DLQ_POLICY.pattern.split('$').join('$$')}'`);
    expect(compose).toContain(`definition='${JSON.stringify(DLQ_POLICY.definition)}'`);
    expect(compose).toContain(`priority=${DLQ_POLICY.priority}`);
  });
});
