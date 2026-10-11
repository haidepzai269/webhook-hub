import { randomBytes } from 'crypto';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';
import { parseInput, prismaStore, ShopSettings } from '../src/settings';

/**
 * SK2 trên Postgres THẬT (RUN_DB_TESTS=1, hubv): bảng `shop.settings` của migration 20261012020000_shop_settings —
 * cột bí mật chỉ có ciphertext, đọc lại giải mã đúng, `shop_user` (role runtime của Shop) có quyền ghi/đọc.
 * Dòng có sẵn (nếu có) được trả lại nguyên trạng sau test.
 */
describeDb('shop.settings (Postgres, SK2)', () => {
  const db = newTestPrisma('owner');
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const key = randomBytes(32).toString('base64');
  const env = { SHOP_SETTINGS_KEY: key } as unknown as NodeJS.ProcessEnv;
  const conn = `hubs://hk_test_${'Q'.repeat(39)}zzzz@hub.example/proj-q`;
  let before: any = null;

  beforeAll(async () => {
    before = await db.shopSetting.findUnique({ where: { id: 1 } });
  });
  afterAll(async () => {
    if (before) await db.shopSetting.update({ where: { id: 1 }, data: before });
    else await db.shopSetting.deleteMany({ where: { id: 1 } });
    await db.$disconnect();
  });

  it('[SK:U4] (phần b) cột *_encrypted trong DB không chứa plaintext; đọc lại giải mã đúng; chỉ có MỘT dòng', async () => {
    const s = new ShopSettings(prismaStore(db), env, log);
    await s.save(parseInput({ hubConnectionUrl: conn, payosApiKey: 'payos-api-key-PLAINTEXT-1', paymentSourceKeys: ['src_payos_q'], bankCode: 'MB' }) as any);
    await s.save(parseInput({ payosChecksumKey: 'checksum-PLAINTEXT-2' }) as any); // lần 2: upsert, giữ trường cũ
    const rows = await db.$queryRaw<any[]>`SELECT * FROM shop.settings`;
    expect(rows).toHaveLength(1);
    const raw = JSON.stringify(rows);
    for (const v of [conn, 'PLAINTEXT', 'Q'.repeat(39)]) expect(raw).not.toContain(v);
    expect(rows[0].payment_source_keys).toEqual(['src_payos_q']);
    const r = await new ShopSettings(prismaStore(db), env, log).get();
    expect(r.env).toMatchObject({ HUB_URL: conn, PAYOS_API_KEY: 'payos-api-key-PLAINTEXT-1', PAYOS_CHECKSUM_KEY: 'checksum-PLAINTEXT-2', SHOP_PAYMENT_SOURCE_KEYS: 'src_payos_q', SHOP_BANK_CODE: 'MB' });
    await expect(db.$executeRaw`INSERT INTO shop.settings (id, updated_at) VALUES (2, now())`).rejects.toThrow(); // CHECK id = 1
  });

  it('migration cấp quyền cho shop_user (role runtime của Shop) nếu role tồn tại', async () => {
    const [{ exists }] = await db.$queryRaw<{ exists: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shop_user') AS exists`;
    if (!exists) return; // máy không có shop_user: migration bỏ qua GRANT (đúng thiết kế)
    const [p] = await db.$queryRaw<{ ok: boolean }[]>`SELECT has_table_privilege('shop_user', 'shop.settings', 'SELECT, INSERT, UPDATE') AS ok`;
    expect(p.ok).toBe(true);
  });
});
