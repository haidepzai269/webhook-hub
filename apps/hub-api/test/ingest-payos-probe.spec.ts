import { Prisma } from '@prisma/client';
import { PayOS } from '@payos/node';
import { aesGcmEncrypt } from '@hub/crypto';
import { IngestService } from '../src/modules/ingest/ingest.service';

/**
 * KQ1 (SPEC-ket-noi §5.1/§11, [KN:U16]): request kiểm tra của PayOS lúc `confirm-webhook` đi qua ingest Y NHƯ webhook
 * thường — verify chữ ký, LƯU raw_event ACCEPTED + outbox, COMMIT, rồi 200 (BB-3). Ingest KHÔNG biết đây là probe
 * (nhận diện nằm ở PayosAdapter.normalize). PayOS kiểm lại (kết nối lại) -> cùng khoá -> trùng -> vẫn 200, không 409/4xx
 * (PayOS coi 4xx là xác nhận thất bại).
 */
describe('Ingest — PayOS confirm probe (KQ1)', () => {
  const MASTER = 'test-master-key-at-least-32-characters!!';
  const KEY = 'checksum-key-for-test-kq1-1234567890';
  const data = {
    orderCode: 123, amount: 3000, description: 'VQRIO123', accountNumber: '12345678', reference: 'TF230204212323',
    transactionDateTime: '2023-02-04 18:25:00', currency: 'VND', paymentLinkId: '124c33293c43417ab7879e14c8d9eb18',
    code: '00', desc: 'Thành công', counterAccountBankId: '', counterAccountBankName: '', counterAccountName: '',
    counterAccountNumber: '', virtualAccountName: '', virtualAccountNumber: '',
  };
  let raw = '';

  beforeAll(async () => {
    process.env.MASTER_KEY = MASTER;
    const signature = await new PayOS({ clientId: 'x', apiKey: 'x', checksumKey: KEY }).crypto.createSignatureFromObj(data, KEY);
    raw = JSON.stringify({ code: '00', desc: 'success', success: true, data, signature });
  });

  function build(txImpl: (fn: any, n: number) => Promise<any>, redisHit = false) {
    const source = { id: 'src-payos', tenantId: 'tenant-a', provider: 'payos', isActive: true, secrets: [{ id: 's1', secretEncrypted: aesGcmEncrypt(KEY, MASTER) }] };
    const tx = {
      rawEvent: { create: jest.fn(async ({ data: d }: any) => ({ id: 'raw-1', ...d })) },
      outbox: { create: jest.fn(async () => ({})) },
    };
    let calls = 0;
    const prisma: any = {
      findSourceBySourceKeyForIngest: jest.fn().mockResolvedValue(source),
      rawEvent: { create: jest.fn().mockResolvedValue({}) },
      tenantTx(_t: any, fn: any) {
        calls += 1;
        return txImpl(async (t: any) => fn(t ?? tx), calls);
      },
    };
    const redis: any = {
      checkRateLimit: jest.fn().mockResolvedValue(true),
      getIdempotencyKey: jest.fn().mockResolvedValue(redisHit ? '1' : null),
      setIdempotencyKey: jest.fn().mockResolvedValue(undefined),
    };
    return { svc: new IngestService(prisma, redis, { traceIngested: jest.fn() }), tx, redis, txCalls: () => calls };
  }

  const req = () => ({
    provider: 'payos' as const,
    sourceKey: 'src_payos_main',
    headers: { 'content-type': 'application/json' },
    rawBody: Buffer.from(raw),
    body: JSON.parse(raw),
    contentType: 'application/json',
  });

  it('[KN:U16] (phần g) probe ký đúng -> raw_event ACCEPTED (signature_valid) + outbox trong CÙNG tx, 200 code "00"', async () => {
    const { svc, tx } = build(async (fn) => fn(undefined));
    const r = await svc.ingestWebhook(req() as any);
    expect(r.status).toBe(200);
    expect((r.body as any).code).toBe('00');
    expect(tx.rawEvent.create).toHaveBeenCalledTimes(1);
    const row = (tx.rawEvent.create.mock.calls[0] as any)[0].data;
    expect(row).toMatchObject({ status: 'ACCEPTED', idempotencyKey: 'payos:123:TF230204212323' });
    expect(tx.outbox.create).toHaveBeenCalledTimes(1);
  });

  it('[KN:U16] (phần h) PayOS kiểm LẠI (kết nối lại) — Redis trúng HOẶC Postgres báo trùng -> 200 duplicate, không 409/4xx, không bản ghi thứ hai', async () => {
    const first = build(async (fn) => fn(undefined));
    expect((await first.svc.ingestWebhook(req() as any)).status).toBe(200);

    const viaRedis = build(async (fn) => fn(undefined), true);
    const r2 = await viaRedis.svc.ingestWebhook(req() as any);
    expect(r2.status).toBe(200);
    expect(viaRedis.tx.rawEvent.create).not.toHaveBeenCalled();
    expect(viaRedis.redis.getIdempotencyKey.mock.calls[0][0]).toContain('payos:123:TF230204212323');

    const viaPg = build(async () => {
      throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
    });
    const r3 = await viaPg.svc.ingestWebhook(req() as any);
    expect(r3.status).toBe(200);
    expect((r3.body as any).code).toBe('00');
    expect(viaPg.txCalls()).toBe(1);
  });

  it('[KN:U16] (phần i) đúng mẫu nhưng chữ ký sai -> 401, không lưu ACCEPTED, không outbox (nhận diện probe chỉ sau verify)', async () => {
    const { svc, tx } = build(async (fn) => fn(undefined));
    const bad = JSON.parse(raw);
    bad.signature = bad.signature.replace(/^./, (c: string) => (c === 'a' ? 'b' : 'a'));
    const b = JSON.stringify(bad);
    const r = await svc.ingestWebhook({ ...req(), rawBody: Buffer.from(b), body: JSON.parse(b) } as any);
    expect(r.status).toBe(401);
    expect(tx.outbox.create).not.toHaveBeenCalled();
    const accepted = tx.rawEvent.create.mock.calls.filter((c: any) => c[0]?.data?.status === 'ACCEPTED');
    expect(accepted).toHaveLength(0);
  });
});
