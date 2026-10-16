import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
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

  it('escape hatch cảnh báo của operator: gọi ngoài module alerts → đỏ; trong module alerts / prisma.service thì xanh', () => {
    const call = 'await this.prisma.operator' + 'AlertsAcrossTenants({ dir: "older", limit: 1 });';
    const f = files({
      'apps/hub-api/src/modules/api/x.ts': call + '\nconst t = await p.operator' + 'FindAlertTenant(id);',
      'apps/hub-worker/src/y.ts': 'p.operator' + 'AlertSummaryAcrossTenants ()',
      'apps/hub-api/src/modules/alerts/alerts-api.ts': call,
      'libs/database/src/prisma.service.ts': 'public operator' + 'AlertsAcrossTenants(f) {}',
    });
    const r = runGates([byId('operator-alerts')], f.list, f.read);
    expect(r[0].violations.map((v) => `${v.file}:${v.line}`)).toEqual(['apps/hub-api/src/modules/api/x.ts:1', 'apps/hub-api/src/modules/api/x.ts:2', 'apps/hub-worker/src/y.ts:1']);
  });

  it('review QT-S3 L6: escape hatch operatorProjectUsage gọi ngoài projects.controller → đỏ; controller / prisma.service thì xanh', () => {
    const call = 'const rows = await this.prisma.operator' + 'ProjectUsage();';
    const f = files({
      'apps/hub-api/src/modules/storage/x.ts': call,
      'apps/hub-api/src/modules/console/projects.controller.ts': call,
      'libs/database/src/prisma.service.ts': 'public operator' + 'ProjectUsage() {}',
    });
    const r = runGates([byId('operator-project-usage')], f.list, f.read);
    expect(r[0].violations.map((v) => `${v.file}:${v.line}`)).toEqual(['apps/hub-api/src/modules/storage/x.ts:1']);
  });

  it('ADR-235: escape hatch số đếm xuyên dự án (member|operator)ProjectStatsAcrossTenants gọi ngoài projects.controller → đỏ; controller / prisma.service thì xanh', () => {
    const member = 'const rows = await this.prisma.member' + 'ProjectStatsAcrossTenants(p.id);';
    const op = 'await prisma.operator' + 'ProjectStatsAcrossTenants ()';
    const f = files({
      'apps/hub-api/src/modules/api/x.ts': member,
      'apps/hub-worker/src/y.ts': op,
      'apps/hub-api/src/modules/console/projects.controller.ts': member + '\n' + op,
      'libs/database/src/prisma.service.ts': 'public member' + 'ProjectStatsAcrossTenants(userId) {}',
    });
    const r = runGates([byId('project-stats-cross-tenant')], f.list, f.read);
    expect(r[0].violations.map((v) => `${v.file}:${v.line}`)).toEqual(['apps/hub-api/src/modules/api/x.ts:1', 'apps/hub-worker/src/y.ts:1']);
  });

  it('[QT:T4] LOCKED: delivery đã có vẫn được giao và retry — đường giao/retry của hub-worker không đọc nấc/khoá dung lượng (gate trên repo thật = 0; thêm kiểm khoá vào relay/consumer → đỏ)', () => {
    const gate = byId('delivery-ignores-storage-lock');
    // Ca đỏ tổng hợp: ai đó thêm "LOCKED thì đừng giao" vào consumer / relay / sweeper.
    const f = files({
      'apps/hub-worker/src/consumers/delivery.consumer.ts': 'if (is' + 'WriteBlocked(level, false, true)) return;',
      'apps/hub-worker/src/scheduler/outbox.relay.ts': 'const u = await repo.lock' + 'ProjectUsageForSignal();',
      'apps/hub-worker/src/scheduler/delivery.sweeper.ts': "// chú thích nhắc project" + "_usage không tính\nconst x = 'SKIP LOCKED';",
      'apps/hub-worker/src/scheduler/storage.job.ts': 'is' + 'WriteBlocked(l)', // ngoài phạm vi: job đo nấc
    });
    const r = runGates([gate], f.list, f.read);
    expect(r[0].violations.map((v) => `${v.file}:${v.line}`)).toEqual([
      'apps/hub-worker/src/consumers/delivery.consumer.ts:1',
      'apps/hub-worker/src/scheduler/outbox.relay.ts:1',
    ]);
    // Repo thật: phạm vi không rỗng (gate thật sự quét file giao) và 0 vi phạm.
    const ROOT = path.resolve(__dirname, '..', '..');
    const out = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'apps/hub-worker/src'], { cwd: ROOT, encoding: 'utf8' });
    const list = out.stdout.split('\n').map((x) => x.trim()).filter((x) => x && fs.existsSync(path.join(ROOT, x)));
    const scoped = list.filter(gate.include);
    expect(scoped).toEqual(expect.arrayContaining(['apps/hub-worker/src/consumers/delivery.consumer.ts', 'apps/hub-worker/src/scheduler/outbox.relay.ts', 'apps/hub-worker/src/scheduler/delivery.sweeper.ts']));
    const real = runGates([gate], list, (x) => fs.readFileSync(path.join(ROOT, x), 'utf8'));
    expect(real[0].violations.map((v) => `${v.file}:${v.line} ${v.text}`)).toEqual([]);
  });

  it('[CB:T8] (phần c) escape hatch vòng gửi email: gọi ngoài alert-email.sender → đỏ; trong sender / prisma.service thì xanh', () => {
    const call = 'await this.prisma.alertEmail' + 'OutboxClaim(now, 20, 1000);';
    const f = files({
      'apps/hub-api/src/modules/alerts/alerts-api.ts': call,
      'apps/hub-worker/src/scheduler/alert.evaluator.ts': 'p.alertEmail' + 'OutboxMarkSent (id, now)',
      'apps/hub-worker/src/scheduler/alert-email.sender.ts': call,
      'libs/database/src/prisma.service.ts': 'public alertEmail' + 'OutboxClaim(now) {}',
    });
    const r = runGates([byId('alert-email-outbox')], f.list, f.read);
    expect(r[0].violations.map((v) => `${v.file}:${v.line}`)).toEqual(['apps/hub-api/src/modules/alerts/alerts-api.ts:1', 'apps/hub-worker/src/scheduler/alert.evaluator.ts:1']);
  });

  it('chữ ký: === cạnh signature → đỏ; typeof … !== "string" / === null không phải so sánh giá trị', () => {
    const f = files({
      'libs/providers/src/a.ts': 'if (sig ' + '=== expectedSignature) ok();\nif (typeof body.signature ' + "!== 'string' || x === null) bad();",
    });
    const r = runGates([byId('sig-compare')], f.list, f.read);
    expect(r[0].violations.map((v) => v.line)).toEqual([1]);
  });

  it('review PK4 T-3: so token/khoá bằng === / !== (providers + ingest) -> đỏ; so với hằng, so tên trường config, kiểm độ dài -> không báo', () => {
    const EQ = '=' + '==';
    const NE = '!' + '==';
    const f = files({
      'libs/providers/src/b.ts': [
        `if (presented.length ${NE} 1 || !expected || presented[0] ${NE} expected) return reject;`, // 1: so token
        `const isMac = (h) => h.kind ${EQ} 'hmac-echo';`, // 2: so với hằng chuỗi
        `if (h.macField ${EQ} h.tokenField) return bad();`, // 3: tên trường config
        `if (secret ${EQ} provided) ok();`, // 4: so secret
        `if (c.scheme ${EQ} TEMPLATE_SCHEME) return validateSignedTemplate(c);`, // 5: "signed" không phải "sig"
        `if (token.length ${EQ} 0) return null;`, // 6: độ dài
      ].join('\n'),
      'apps/hub-api/src/modules/ingest/x.ts': `if (verifyToken ${NE} req.query.t) deny();`,
      'apps/hub-api/src/modules/other/y.ts': `if (verifyToken ${NE} req.query.t) deny();`, // ngoài phạm vi
    });
    const r = runGates([byId('sig-compare')], f.list, f.read);
    expect(r[0].violations.map((v) => `${v.file}:${v.line}`)).toEqual(['libs/providers/src/b.ts:1', 'libs/providers/src/b.ts:4', 'apps/hub-api/src/modules/ingest/x.ts:1']);
  });

  it('test: .only / it.skip mới → đỏ; khởi tạo PrismaClient trong spec ngoài helper → đỏ', () => {
    const f = files({
      'apps/x/test/a.spec.ts': 'it' + ONLY + "'x', f);\nconst p = new " + 'PrismaClient();',
      'libs/database/test/support/test-db.ts': 'return new ' + 'PrismaClient(opts);',
    });
    const r = runGates([byId('test-focus-skip'), byId('test-prisma-client')], f.list, f.read);
    expect(r.map((g) => g.violations.length)).toEqual([1, 1]);
  });

  it('R2-5: lớp con của TenantScopedRepository chỉ ở danh sách cho phép (FlowScopedRepository) — lớp con mới -> đỏ', () => {
    const EXT = 'extends ' + 'TenantScopedRepository';
    const f = files({
      'apps/hub-api/src/modules/flow/flow.repository.ts': `export class FlowScopedRepository ${EXT} {}`,
      'apps/hub-api/src/modules/x/x.repository.ts': `export class Lach ${EXT} {}`,
    });
    const r = runGates([byId('repo-subclass')], f.list, f.read);
    expect(r[0].violations.map((v) => v.file)).toEqual(['apps/hub-api/src/modules/x/x.repository.ts']);
  });

  it('R3-3: bí danh (import { TenantScopedRepository as Base }, const B = TenantScopedRepository) cũng bị bắt', () => {
    const T = 'TenantScoped' + 'Repository';
    const f = files({
      'apps/hub-api/src/modules/y/a.ts': `import { ${T} as Base } from '@hub/database';
export class Lach extends Base {}`,
      'apps/hub-api/src/modules/y/b.ts': `import { ${T} } from '@hub/database';
const B = ${T};
export class Lach2 extends B {}`,
      'apps/hub-api/src/modules/y/c.ts': `import { ${T} as Base } from '@hub/database';
const r = new Base(p, t);`,
    });
    const r = runGates([byId('repo-subclass')], f.list, f.read);
    expect(r[0].violations.map((v) => `${v.file}:${v.line}`)).toEqual(['apps/hub-api/src/modules/y/a.ts:2', 'apps/hub-api/src/modules/y/b.ts:3']);
  });

  it('[AR:R-7] migration dữ liệu sau RLS: UPDATE/INSERT/DELETE bảng có RLS mà thiếu cờ hệ thống -> đỏ; có cờ, hoặc migration trước RLS, hoặc chỉ DDL -> xanh', () => {
    const M = 'libs/database/prisma/migrations/';
    const FLAG = "SET LOCAL app.rls" + "_system = 'on';";
    const f = files({
      [M + '20261020000000_backfill_x/migration.sql']: ['-- backfill', 'UPDATE "hub"."deliveries" SET x = 1;', 'INSERT INTO hub.events (id) VALUES (1);'].join('\n'),
      [M + '20261020000001_backfill_ok/migration.sql']: [FLAG, 'UPDATE "hub"."deliveries" SET x = 1;'].join('\n'),
      [M + '20261020000002_ddl_only/migration.sql']: ['ALTER TABLE "hub"."deliveries" ADD COLUMN y int;', 'CREATE INDEX i ON hub.events (id);'].join('\n'),
      [M + '20261020000003_non_rls/migration.sql']: ['UPDATE hub.outbox SET a = 1;', 'DELETE FROM "hub"."users" WHERE false;'].join('\n'),
      [M + '20261011060000_endpoint_owner_from_audit/migration.sql']: 'UPDATE hub.destinations SET a = 1;',
      [M + '20261020000004_cte/migration.sql']: 'WITH d AS (DELETE FROM hub.raw_events RETURNING 1) SELECT 1;',
    });
    const r = runGates([byId('data-migration-rls')], f.list, f.read);
    expect(r[0].violations.map((v) => `${v.file.slice(M.length)}:${v.line}`)).toEqual([
      '20261020000000_backfill_x/migration.sql:2',
      '20261020000000_backfill_x/migration.sql:3',
      '20261020000004_cte/migration.sql:1',
    ]);
  });

  it('§14.3: fixture-account quét cả BODY đã giải mã (bodyBase64), không chỉ text file', () => {
    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
    const f = files({
      'tools/hub-sim/fixtures/payos/x.json': JSON.stringify({ bodyBase64: b64('{\n  "accountNumber": "0123456789012"\n}') }, null, 2),
      'tools/hub-sim/fixtures/payos/ok.json': JSON.stringify({ bodyBase64: b64('{\n  "amount": 69000\n}') }, null, 2),
    });
    const r = runGates([byId('fixture-account')], f.list, f.read);
    expect(r[0].violations.map((v) => v.file)).toEqual(['tools/hub-sim/fixtures/payos/x.json']);
    expect(r[0].violations[0].text).toContain('"accountNumber": "0123456789012"');
  });

  it('§14.3 / ADR-159: ngoại lệ probe PayOS HẸP — đúng một file + đúng dòng reference hằng số tài liệu; số khác cùng file vẫn đỏ', () => {
    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
    const PROBE = 'tools/hub-sim/fixtures/payos/confirm-probe.json';
    const ok = files({ [PROBE]: JSON.stringify({ bodyBase64: b64('{\n  "reference": "TF230204212323",\n  "amount": 3000\n}') }) });
    const r1 = runGates([byId('fixture-account')], ok.list, ok.read);
    expect(r1[0].violations).toEqual([]);
    expect(r1[0].excepted.map((v) => v.file)).toEqual([PROBE]);
    expect(r1[0].excepted[0].reason).toMatch(/ADR-159/);
    // Cùng file, dãy số khác (số tài khoản) → vẫn vi phạm.
    const leak = files({ [PROBE]: JSON.stringify({ bodyBase64: b64('{\n  "reference": "TF230204212323",\n  "accountNumber": "0123456789012"\n}') }) });
    expect(runGates([byId('fixture-account')], leak.list, leak.read)[0].violations).toHaveLength(1);
    // Cùng dòng reference nhưng ở file KHÁC → vẫn vi phạm.
    const other = files({ 'tools/hub-sim/fixtures/payos/paid-69000.json': JSON.stringify({ bodyBase64: b64('{\n  "reference": "TF230204212323"\n}') }) });
    expect(runGates([byId('fixture-account')], other.list, other.read)[0].violations).toHaveLength(1);
  });

  it('Shop: TỔNG apps/shop/src ≤ 600 dòng (ADR-156), không chỉ main.ts', () => {
    const big = files({ 'apps/shop/src/main.ts': 'x\n'.repeat(300), 'apps/shop/src/settings.ts': 'x\n'.repeat(301), 'apps/shop/test/a.spec.ts': 'x\n'.repeat(999) });
    expect(runGates([byId('shop-size')], big.list, big.read)[0].violations).toHaveLength(1);
    const ok = files({ 'apps/shop/src/main.ts': 'x\n'.repeat(300), 'apps/shop/src/settings.ts': 'x\n'.repeat(300) });
    expect(runGates([byId('shop-size')], ok.list, ok.read)[0].violations).toHaveLength(0);
  });
  it('ADR-210 (PK9 hotfix): import subpath `@hub/<lib>/…` trong src phía server → đỏ (Node không resolve, package không khai exports); barrel `@hub/<lib>` và apps/web (alias Next) thì xanh', () => {
    const H = '@h' + 'ub/';
    const f = files({
      'apps/hub-api/src/a.ts': `import { CATALOG } from '${H}providers/catalog/catalog';
import { X } from '${H}providers';`,
      'apps/hub-worker/src/b.ts': `const c = require('${H}common/x');
const d = await import('${H}crypto/y');`,
      'libs/database/src/c.ts': `export * from '${H}common/z';`,
      'apps/web/src/lib/hub/catalog.ts': `import { identify } from '${H}providers/catalog';`,
      'apps/hub-api/test/x.spec.ts': `import { CATALOG } from '${H}providers/catalog/catalog';`,
    });
    const r = runGates([byId('server-lib-subpath')], f.list, f.read);
    expect(r[0].violations.map((v) => v.file + ':' + v.line)).toEqual([
      'apps/hub-api/src/a.ts:1',
      'apps/hub-worker/src/b.ts:1',
      'apps/hub-worker/src/b.ts:2',
      'libs/database/src/c.ts:1',
    ]);
  });
  it('review PK9-R2 T-R2-1: server-lib-subpath bắt require.resolve, template literal, import( / require( xuống dòng; chú thích thì không', () => {
    const H = '@h' + 'ub/';
    const B = '`';
    const f = files({
      'apps/hub-api/src/a.ts': `const p = require.resolve('${H}providers/catalog');
const q = require(${B}${H}common/x${B});
const r = await import(
  '${H}crypto/y'
);
// import('${H}crypto/z') trong chú thích
const ok = require('${H}providers');`,
    });
    const r = runGates([byId('server-lib-subpath')], f.list, f.read);
    expect(r[0].violations.map((v) => v.file + ':' + v.line)).toEqual(['apps/hub-api/src/a.ts:1', 'apps/hub-api/src/a.ts:2', 'apps/hub-api/src/a.ts:3']);
  });
  it('review PK9-R2 T-R2-2 (E28): apps/web src không import barrel @hub/providers (chỉ /catalog); spec của web thì được', () => {
    const H = '@h' + 'ub/';
    const f = files({
      'apps/web/src/a.tsx': `import { identify } from '${H}providers/catalog';
import { validateGenericConfig } from '${H}providers';`,
      'apps/web/src/b.ts': `const m = await import(
  "${H}providers"
);`,
      'apps/web/src/lib/hub/x.spec.ts': `import { validateGenericConfig } from '${H}providers';`,
      'apps/hub-api/src/c.ts': `import { X } from '${H}providers';`,
    });
    const r = runGates([byId('web-no-provider-barrel')], f.list, f.read);
    expect(r[0].violations.map((v) => v.file + ':' + v.line)).toEqual(['apps/web/src/a.tsx:2', 'apps/web/src/b.ts:1']);
  });
});
