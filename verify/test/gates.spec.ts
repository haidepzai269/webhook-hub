import { runGates, Gate, GATES } from '../lib/gates';

// Chuỗi vi phạm được GHÉP để chính file này không vi phạm luật khi gate quét repo thật.
const ONLY = '.on' + 'ly(';
const files = (m: Record<string, string>) => ({ list: Object.keys(m), read: (f: string) => m[f] });
const byId = (id: string): Gate => GATES.find((g) => g.id === id)!;

describe('grep gác cổng §7.3', () => {
  it('[VF:VT7] tools/hub-sim import từ libs/ hoặc @hub → đỏ; import độc lập thì xanh', () => {
    const bad = files({
      'tools/hub-sim/src/sign.ts': "import { hmac } from '../../" + "libs/crypto/src';\nimport x from '@h" + "ub/providers';",
      'tools/hub-sim/src/ok.ts': "import { createHmac } from 'crypto';",
    });
    const r = runGates([byId('sim-independent')], bad.list, bad.read);
    expect(r[0].violations.map((v) => v.file + ':' + v.line)).toEqual(['tools/hub-sim/src/sign.ts:1', 'tools/hub-sim/src/sign.ts:2']);
  });

  it('BB-1: orderCode trong apps/hub-worker → đỏ; ngoại lệ có lý do (PayOS adapter) thì không', () => {
    const f = files({
      'apps/hub-worker/src/x.ts': 'const ' + 'orderCode = 1;',
      'libs/providers/src/payos.adapter.ts': 'const ' + 'orderCode = data.' + 'orderCode;',
    });
    const r = runGates([byId('bb1')], f.list, f.read);
    expect(r[0].violations.map((v) => v.file)).toEqual(['apps/hub-worker/src/x.ts']);
    expect(r[0].excepted.map((v) => v.file)).toEqual(['libs/providers/src/payos.adapter.ts']);
  });

  it('BB-5: prisma.<model>. ngoài libs/database/src → đỏ; tx.<model> trong transaction thì không tính', () => {
    const f = files({
      'apps/hub-api/src/a.ts': 'await this.' + 'prisma.delivery.findMany();\nawait tx.delivery.create();',
      'libs/database/src/tenant-scoped.repository.ts': 'this.' + 'prisma.delivery.findMany()',
    });
    const r = runGates([byId('bb5')], f.list, f.read);
    expect(r[0].violations.map((v) => `${v.file}:${v.line}`)).toEqual(['apps/hub-api/src/a.ts:1']);
  });

  it('chữ ký: === cạnh signature → đỏ; typeof … !== "string" / === null không phải so sánh giá trị', () => {
    const f = files({
      'libs/providers/src/a.ts': 'if (sig ' + '=== expectedSignature) ok();\nif (typeof body.signature ' + "!== 'string' || x === null) bad();",
    });
    const r = runGates([byId('sig-compare')], f.list, f.read);
    expect(r[0].violations.map((v) => v.line)).toEqual([1]);
  });

  it('test: .only / it.skip mới → đỏ; khởi tạo PrismaClient trong spec ngoài helper → đỏ', () => {
    const f = files({
      'apps/x/test/a.spec.ts': 'it' + ONLY + "'x', f);\nconst p = new " + 'PrismaClient();',
      'libs/database/test/support/test-db.ts': 'return new ' + 'PrismaClient(opts);',
    });
    const r = runGates([byId('test-focus-skip'), byId('test-prisma-client')], f.list, f.read);
    expect(r.map((g) => g.violations.length)).toEqual([1, 1]);
  });

  it('Shop ≤ 300 dòng', () => {
    const f = files({ 'apps/shop/src/main.ts': 'x\n'.repeat(301) });
    expect(runGates([byId('shop-size')], f.list, f.read)[0].violations).toHaveLength(1);
  });
});
