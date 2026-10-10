import { GithubAdapter, PayosAdapter, SepayAdapter } from '../src';
import { hmacSha256 } from '@hub/crypto';

describe('Provider Adapters Tests', () => {
  const context = {
    tenantId: '00000000-0000-0000-0000-000000000001',
    sourceId: 'src_test_123',
    correlationId: 'corr_test_456',
    rawEventId: 'raw_test_789',
  };

  describe('GitHub Adapter', () => {
    const adapter = new GithubAdapter();
    const secret = 'gh_secret_test';
    const payload = JSON.stringify({
      ref: 'refs/heads/main',
      repository: { name: 'webhook-hub' },
      head_commit: { id: 'c123', timestamp: '2026-09-18T10:00:00Z' },
    });
    const rawBody = Buffer.from(payload);
    const validSignature = 'sha256=' + hmacSha256(secret, rawBody);

    it('verify thành công khi chữ ký đúng trên raw bytes', async () => {
      const isValid = await adapter.verify(
        {
          provider: 'github',
          sourceKey: 'test',
          headers: { 'x-hub-signature-256': validSignature, 'x-github-delivery': 'del_123' },
          rawBody,
          body: JSON.parse(payload),
        },
        [secret],
      );

      expect(isValid).toBe(true);
    });

    it('từ chối chữ ký sai', async () => {
      const isValid = await adapter.verify(
        {
          provider: 'github',
          sourceKey: 'test',
          headers: { 'x-hub-signature-256': 'sha256=wrong_signature' },
          rawBody,
          body: JSON.parse(payload),
        },
        [secret],
      );

      expect(isValid).toBe(false);
    });

    it('trích xuất idempotency key từ X-GitHub-Delivery', () => {
      const key = adapter.extractIdempotencyKey({
        provider: 'github',
        sourceKey: 'test',
        headers: { 'x-github-delivery': 'del_uuid_unique' },
        rawBody,
        body: JSON.parse(payload),
      });

      expect(key).toBe('github:del_uuid_unique');
    });

    it('normalize chuyển đổi đúng sang repo.push', () => {
      const events = adapter.normalize(
        {
          provider: 'github',
          sourceKey: 'test',
          headers: { 'x-github-event': 'push' },
          rawBody,
          body: JSON.parse(payload),
        },
        context,
      );

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('repo.push');
      expect(events[0].source).toBe('github');
    });
  });

  describe('PayOS Adapter', () => {
    const adapter = new PayosAdapter();
    const checksumKey = 'payos_checksum_secret';
    const data = {
      orderCode: 10234,
      amount: 2000,
      description: 'DH10234 thanh toan',
      reference: 'FT999',
    };
    // Sắp xếp key: amount=2000&description=DH10234 thanh toan&orderCode=10234&reference=FT999
    const sortedString = `amount=2000&description=DH10234 thanh toan&orderCode=10234&reference=FT999`;
    const signature = hmacSha256(checksumKey, sortedString);

    it('verify thành công payload PayOS với checksum key', async () => {
      const isValid = await adapter.verify(
        {
          provider: 'payos',
          sourceKey: 'test',
          headers: {},
          rawBody: Buffer.from(''),
          body: { code: '00', data, signature },
        },
        [checksumKey],
      );

      expect(isValid).toBe(true);
    });

    it('normalize sang payment.received (S3-2, catalog)', () => {
      const events = adapter.normalize(
        {
          provider: 'payos',
          sourceKey: 'test',
          headers: {},
          rawBody: Buffer.from(''),
          body: { data },
        },
        context,
      );

      // body thiếu `code` -> không phải "00" -> payment.failed; có code "00" -> payment.received
      expect(events[0].type).toBe('payment.failed');
      expect(events[0].subject).toBe('payment:FT999');
      expect(events[0].data.amount).toBe(2000);
      expect(events[0].data.memo).toBe('DH10234 thanh toan');
    });
  });

  describe('SePay Adapter', () => {
    const adapter = new SepayAdapter();
    const apiKey = 'sepay_live_key_xyz';

    it('verify thành công header Authorization: Apikey', async () => {
      const isValid = await adapter.verify(
        {
          provider: 'sepay',
          sourceKey: 'test',
          headers: { authorization: `Apikey ${apiKey}` },
          rawBody: Buffer.from(''),
          body: {},
        },
        [apiKey],
      );

      expect(isValid).toBe(true);
    });

    it('normalize sang payment.received (S3-2, catalog)', () => {
      const events = adapter.normalize(
        {
          provider: 'sepay',
          sourceKey: 'test',
          headers: {},
          rawBody: Buffer.from(''),
          body: {
            id: 12345,
            transferType: 'in',
            transferAmount: 50000,
            accountNumber: '12345678',
            code: 'DH20001',
          },
        },
        context,
      );

      expect(events[0].type).toBe('payment.received');
      expect(events[0].data.amount).toBe(50000);
    });
  });
});
