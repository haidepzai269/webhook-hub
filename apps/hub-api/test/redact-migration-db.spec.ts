import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { describeDb, newTestPrisma } from '../../../libs/database/test/support/test-db';

/**
 * Review SPEC-1 #1 (ADR-051) trên Postgres THẬT (RUN_DB_TESTS=1): migration
 * 20261010010000_redact_raw_event_headers che key trong dữ liệu cũ, giữ chữ ký HMAC GitHub,
 * không đụng body_raw, và chạy lại vô hại.
 */

const MIGRATION = join(
  __dirname,
  '../../../libs/database/prisma/migrations/20261010010000_redact_raw_event_headers/migration.sql',
);

describeDb('Migration che header raw_events (Postgres)', () => {
  const prisma = newTestPrisma();
  const tenant = randomUUID();
  const runId = randomUUID().slice(0, 8);
  let sourceId = '';

  // Prisma $executeRawUnsafe chỉ chạy MỘT câu lệnh -> tách theo ';' cuối câu (file không có ';' trong chuỗi).
  const statements = readFileSync(MIGRATION, 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
  const runMigration = async () => {
    for (const s of statements) await prisma.$executeRawUnsafe(s);
  };

  beforeAll(async () => {
    sourceId = (
      await prisma.source.create({
        data: { tenantId: tenant, provider: 'sepay', name: `redact-${runId}`, sourceKey: `src_redact_${runId}` },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.rawEvent.deleteMany({ where: { sourceId } });
    await prisma.source.delete({ where: { id: sourceId } });
    await prisma.$disconnect();
  });

  it('che authorization/cookie + signature_header SePay; giữ sha256 GitHub; body_raw nguyên; idempotent', async () => {
    const KEY = `leak_${runId}`;
    const body = Buffer.from(`{"id":1,"k":"Apikey ${KEY}"}`);
    const sepay = await prisma.rawEvent.create({
      data: {
        sourceId,
        idempotencyKey: `sepay:${runId}`,
        headers: { authorization: `Apikey ${KEY}`, Cookie: `sid=${KEY}`, 'content-type': 'application/json' },
        body: {},
        bodyRaw: body,
        signatureHeader: JSON.stringify(`Apikey ${KEY}`),
        signatureValid: true,
      },
    });
    const gh = await prisma.rawEvent.create({
      data: {
        sourceId,
        idempotencyKey: `gh:${runId}`,
        headers: { 'x-hub-signature-256': 'sha256=abc' },
        body: {},
        bodyRaw: Buffer.from('{}'),
        signatureHeader: JSON.stringify('sha256=abc'),
        signatureValid: true,
      },
    });

    await runMigration();
    await runMigration(); // lần 2 vô hại

    const s = await prisma.rawEvent.findUniqueOrThrow({ where: { id: sepay.id } });
    expect(s.headers).toEqual({ authorization: 'Apikey ***', Cookie: '***', 'content-type': 'application/json' });
    expect(s.signatureHeader).toBe('"Apikey ***"');
    expect(Buffer.from(s.bodyRaw).equals(body)).toBe(true);

    const g = await prisma.rawEvent.findUniqueOrThrow({ where: { id: gh.id } });
    expect(g.headers).toEqual({ 'x-hub-signature-256': 'sha256=abc' });
    expect(g.signatureHeader).toBe('"sha256=abc"');
  });
});
