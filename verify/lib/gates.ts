/**
 * VF7 (SPEC-verification §7.3, §3.4): grep gác cổng — chạy trong job CI `unit` và `npm run verify:gates`.
 *
 * Luật KHÔNG được tắt cho xanh. Chỗ code hiện tại vi phạm mà có lý do chính đáng thì vào `exceptions`
 * (file + chuỗi khớp + LÝ DO), được in ra mỗi lần chạy. Ngoại lệ mới phải qua review.
 * Các chuỗi mẫu dưới đây được ghép để chính file này không tự vi phạm khi quét repo.
 */

import { findSuspiciousNumbers } from '../../tools/hub-sim/src/scrub';

export interface GateException {
  file: string;
  /** Regex trên dòng vi phạm; bỏ trống = mọi dòng của file. */
  match?: string;
  reason: string;
}

export interface Gate {
  id: string;
  rule: string;
  source: string;
  /** File thuộc phạm vi luật (đường dẫn POSIX tương đối gốc repo). */
  include: (file: string) => boolean;
  /** Trả các dòng vi phạm (1-based) của một file. */
  check: (text: string, file: string) => { line: number; text: string }[];
  /** Luật trên TỔNG các file thuộc phạm vi (vd trần dòng của cả một thư mục). Chạy trước `check` từng file. */
  checkAll?: (files: { file: string; text: string }[]) => GateViolation[];
  exceptions?: GateException[];
}

export interface GateViolation {
  file: string;
  line: number;
  text: string;
  reason?: string;
}
export interface GateResult {
  gate: Gate;
  violations: GateViolation[];
  excepted: GateViolation[];
}

const isSrc = (f: string) => /^(apps\/[^/]+|libs\/[^/]+)\/src\//.test(f) && /\.(ts|tsx|js)$/.test(f) && !/\.spec\.tsx?$/.test(f);
const isSpec = (f: string) => /\.spec\.tsx?$/.test(f);
const isComment = (ln: string) => /^\s*(\/\/|\*|\/\*)/.test(ln);

function grepLines(re: RegExp, opts: { skipComments?: boolean; transform?: (ln: string) => string } = {}) {
  return (text: string) => {
    const out: { line: number; text: string }[] = [];
    text.split(/\r?\n/).forEach((ln, i) => {
      if (opts.skipComments && isComment(ln)) return;
      const probe = opts.transform ? opts.transform(ln) : ln;
      if (re.test(probe)) out.push({ line: i + 1, text: ln.trim().slice(0, 200) });
    });
    return out;
  };
}

const ACCOUNT_RE = /(?<![\d.])\d{9,14}(?![\d.])/;

/**
 * §14.3: dãy 9–14 chữ số trong fixture — quét text file VÀ body đã giải mã (`bodyBase64`), từng dòng body
 * (body viết JSON nhiều dòng để ngoại lệ theo dòng hẹp được). Body dùng CÙNG luật với hub-sim (`findSuspiciousNumbers`:
 * epoch sau `created`/`timestamp` và số giả đã scrub `90…` được giữ). Hit của body báo ở dòng `bodyBase64` của file.
 */
function fixtureAccountCheck(text: string): { line: number; text: string }[] {
  const out = grepLines(ACCOUNT_RE)(text);
  let body: string | undefined;
  try {
    const j = JSON.parse(text) as { bodyBase64?: unknown };
    if (typeof j?.bodyBase64 === 'string') body = Buffer.from(j.bodyBase64, 'base64').toString('utf8');
  } catch {
    return out;
  }
  if (body === undefined) return out;
  const at = Math.max(1, text.split(/\r?\n/).findIndex((ln) => ln.includes('"bodyBase64"')) + 1);
  body.split(/\r?\n/).forEach((ln, i) => {
    if (findSuspiciousNumbers(ln).length) out.push({ line: at, text: `body:${i + 1}: ${ln.trim().slice(0, 180)}` });
  });
  return out;
}

/** Bảng nghiệp vụ / bảng có lối thoát có tên — mọi truy vấn ngoài libs/database/src phải đi qua repo (BB-5). */
const MODELS = ['source', 'sourceSecret', 'rawEvent', 'event', 'destination', 'subscription', 'delivery', 'deliveryAttempt', 'outbox', 'processedMessage', 'auditLog', 'user', 'projectMember', 'authSession', 'emailToken', 'authAudit', 'alert', 'alertEmail', 'alertPreference'];

const ONLY = '\\.on' + 'ly\\(';
const SKIPS = ['it', 'test', 'describe'].map((k) => `\\b${k}\\.sk` + 'ip\\(').join('|');
const XS = '\\bx(it|describe|test)\\(';
const NEW_PRISMA = 'new ' + 'PrismaClient\\(';
const NO_VERIFY = '--no-' + 'verify|--passWith' + 'NoTests';
const RLS_SYSTEM = 'app\\.rls' + '_system';
/** R-7: migration bật RLS; migration sau mốc này chạy dưới FORCE RLS khi owner không phải superuser (Neon). */
const RLS_MIGRATION_TS = '20261011110000';
/** Bảng có RLS (migration 20261011110000_rls_hub_app; alerts/alert_emails: 20261012050000_alerts; ingest_duplicates: 20261012070000_ingest_duplicates). Thêm bảng RLS mới -> thêm vào đây. */
const RLS_TABLES = ['sources', 'events', 'destinations', 'subscriptions', 'deliveries', 'audit_logs', 'source_secrets', 'raw_events', 'delivery_attempts', 'alerts', 'alert_emails', 'ingest_duplicates'];
const DATA_DML_RLS = new RegExp(`\\b(UPDATE|INSERT\\s+INTO|DELETE\\s+FROM)\\s+("?hub"?\\s*\\.\\s*)?"?(${RLS_TABLES.join('|')})"?(\\s|;|\\(|$)`, 'i');
const OWNER_URL = 'VERIFY_DB_' + 'OWNER_URL|MAIL_DRIVER.*capt' + 'ure';

/**
 * R3-3: `class X extends <tên>` với <tên> là `TenantScopedRepository` HOẶC một bí danh trong cùng file
 * (`import { TenantScopedRepository as Base }`, `const|let B = TenantScopedRepository`).
 */
function repoSubclassCheck(text: string): { line: number; text: string }[] {
  const names = new Set(['TenantScopedRepository']);
  for (const m of text.matchAll(/\bTenantScopedRepository\s+as\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*TenantScopedRepository\b/g)) names.add(m[1]);
  const alt = [...names].map((n) => n.replace(/\$/g, '\\$')).join('|');
  return grepLines(new RegExp(`\\bclass\\s+[\\w$]+\\s+extends\\s+(?:${alt})\\b`), { skipComments: true })(text);
}

/** R2-5: lớp con được phép của TenantScopedRepository — mọi câu SQL của nó phải lọc tenant_id (review từng câu). */
export const REPO_SUBCLASS_ALLOWED: readonly string[] = [
  'apps/hub-api/src/modules/flow/flow.repository.ts', // FlowScopedRepository (ADR nháp EF-2, R-9): SQL đọc hành trình, lọc tenant_id
];

export const GATES: Gate[] = [
  {
    id: 'bb1',
    rule: 'BB-1: hub không biết "đơn hàng" — không `orderCode`, `DH\\d+`, `orders` trong apps/hub-* và libs/*/src',
    source: 'CLAUDE.md BB-1',
    include: (f) => isSrc(f) && (/^apps\/hub-/.test(f) || /^libs\//.test(f)),
    check: grepLines(new RegExp('order' + 'Code|DH\\\\d|\\bord' + 'ers\\b')),
    exceptions: [
      {
        file: 'libs/providers/src/payos.adapter.ts',
        reason: '`orderCode` là tên trường BẮT BUỘC trong payload của PayOS (từ vựng provider, không phải nghiệp vụ hub); adapter chỉ dùng nó làm một phần khoá chống trùng và để nó nằm trong `data.raw` (ADR-058, S3-2).',
      },
      {
        file: 'libs/common/src/canonical/payment.ts',
        match: '^\\s*/\\*\\*',
        reason: 'Chỉ là chú thích nói `orderCode` của PayOS nằm trong `raw` — không có code nào đọc nó.',
      },
    ],
  },
  {
    id: 'bb5',
    rule: 'BB-5: `prisma.<model>.` ngoài libs/database/src = 0 (đi qua TenantScopedRepository)',
    source: 'CLAUDE.md BB-5',
    include: (f) => isSrc(f) && !f.startsWith('libs/database/src/'),
    check: grepLines(new RegExp(`prisma\\.(${MODELS.join('|')})\\.`), { skipComments: true }),
    exceptions: [
      {
        file: 'apps/hub-worker/src/consumers/delivery.consumer.ts',
        match: 'prisma\\.processedMessage\\.',
        reason: '`processed_messages` là bảng hạ tầng (khoá consumer + AMQP message id), không mang dữ liệu tenant; lối thoát có tên `PrismaService.processedMessage`.',
      },
      {
        file: 'apps/hub-worker/src/consumers/normalize.consumer.ts',
        match: 'prisma\\.processedMessage\\.',
        reason: 'Như trên: dedupe theo AMQP message id, không có dữ liệu tenant.',
      },
    ],
  },
  {
    id: 'rls-system',
    rule: '`app.rls_system` chỉ ở PrismaService.systemTx',
    source: 'SPEC-auth §5.12',
    include: (f) => isSrc(f) && f !== 'libs/database/src/prisma.service.ts',
    check: grepLines(new RegExp(RLS_SYSTEM)),
  },
  {
    id: 'operator-alerts',
    rule: 'Escape hatch cảnh báo xuyên project `operator(Alerts|AlertSummary|FindAlert)…(` chỉ được gọi ở apps/hub-api/src/modules/alerts/ (sau OperatorGuard) và khai ở prisma.service.ts',
    source: 'SPEC-canh-bao-nhan-dinh §5.2, review CB3 L3, ADR-169',
    include: (f) => isSrc(f) && f !== 'libs/database/src/prisma.service.ts' && !f.startsWith('apps/hub-api/src/modules/alerts/'),
    check: grepLines(/\boperator(Alerts|AlertSummary|FindAlert)\w*\s*\(/),
  },
  {
    id: 'owner-alerts',
    rule: 'Escape hatch cảnh báo của OWNER `owner(Alerts|AlertSummary)AcrossTenants(` (xuyên project, lọc owner + luật audience trong SQL) chỉ được gọi ở apps/hub-api/src/modules/alerts/ và khai ở prisma.service.ts',
    source: 'SPEC-han-muc-dung-luong ĐÍNH CHÍNH E3, ADR-190',
    include: (f) => isSrc(f) && f !== 'libs/database/src/prisma.service.ts' && !f.startsWith('apps/hub-api/src/modules/alerts/'),
    check: grepLines(/\bowner(Alerts|AlertSummary)AcrossTenants\s*\(/),
  },
  {
    id: 'operator-project-usage',
    rule: 'Escape hatch dung lượng xuyên project `operatorProjectUsage(` (cột operator ở danh sách project) chỉ được gọi ở apps/hub-api/src/modules/console/projects.controller.ts (sau kiểm isOperator) và khai ở prisma.service.ts',
    source: 'SPEC-han-muc-dung-luong QT7, review QT-S3 L6, ADR-191',
    include: (f) => isSrc(f) && f !== 'libs/database/src/prisma.service.ts' && f !== 'apps/hub-api/src/modules/console/projects.controller.ts',
    check: grepLines(/\boperatorProjectUsage\s*\(/),
  },
  {
    id: 'delivery-ignores-storage-lock',
    rule:
      'Khoá dung lượng chỉ chặn CHIỀU GHI ở ingest (hub-api): đường giao/retry/DLQ của hub-worker (consumers/, senders/, circuit/, outbox.relay, delivery.sweeper) không được đọc nấc/khoá dung lượng — delivery đã có vẫn được giao và retry khi LOCKED',
    source: 'SPEC-han-muc-dung-luong QT:T4, review QT-S3 M3, ADR-182',
    include: (f) =>
      isSrc(f) &&
      (/^apps\/hub-worker\/src\/(consumers|senders|circuit)\//.test(f) ||
        ['apps/hub-worker/src/scheduler/outbox.relay.ts', 'apps/hub-worker/src/scheduler/delivery.sweeper.ts'].includes(f)),
    check: grepLines(
      /\b(isWriteBlocked|parseStorageLevel|levelFor|resolveStorageLockEnabled|STORAGE_LOCK_ENABLED|project_storage_full|STORAGE_FULL|HARD_LOCKED|lockProjectUsage\w*|ProjectUsage|projectUsage|project_usage)\b/,
      { skipComments: true },
    ),
  },
  {
    id: 'alert-email-outbox',
    rule: 'Escape hatch vòng gửi email cảnh báo `alertEmailOutbox…(` (xuyên project, systemTx) chỉ được gọi ở apps/hub-worker/src/scheduler/alert-email.sender.ts và khai ở prisma.service.ts',
    source: 'SPEC-canh-bao-nhan-dinh §6, DINH-CHINH D2, ADR-173',
    include: (f) => isSrc(f) && f !== 'libs/database/src/prisma.service.ts' && f !== 'apps/hub-worker/src/scheduler/alert-email.sender.ts',
    check: grepLines(/\balertEmailOutbox\w*\s*\(/),
  },
  {
    id: 'storage-cross-tenant',
    rule:
      'Escape hatch dung lượng xuyên project `storage…AcrossTenants(` (systemTx) chỉ được gọi ở job của hub-worker (storage.job.ts — đo; storage-clean.runner.ts — nhận lệnh dọn; cleanup.job.ts — dọn tự động/retention) và khai ở prisma.service.ts',
    source: 'SPEC-han-muc-dung-luong ĐÍNH CHÍNH E2 + §5.4/§5.5, ADR-183/184',
    include: (f) =>
      isSrc(f) &&
      ![
        'libs/database/src/prisma.service.ts',
        'apps/hub-worker/src/scheduler/storage.job.ts',
        'apps/hub-worker/src/scheduler/storage-clean.runner.ts',
        'apps/hub-worker/src/scheduler/cleanup.job.ts',
      ].includes(f),
    check: grepLines(/\bstorage\w*AcrossTenants\s*\(/),
  },
  {
    id: 'data-migration-rls',
    rule:
      "Migration DỮ LIỆU (UPDATE/INSERT/DELETE trên bảng có RLS) tạo sau 20261011110000_rls_hub_app phải tự `SET LOCAL app.rls" +
      "_system = 'on';` ở đầu file — phòng thủ: nơi owner không có BYPASSRLS, FORCE RLS làm câu lệnh ảnh hưởng 0 dòng mà KHÔNG báo lỗi (Neon của đồ án: owner có BYPASSRLS, ADR-125)",
    source: 'REVIEW-AUTH R-7, ADR-111, ADR-125, DEPLOYMENT §9',
    include: (f) => {
      const m = /^libs\/database\/prisma\/migrations\/(\d{14})_[^/]+\/migration\.sql$/.exec(f);
      return !!m && m[1] > RLS_MIGRATION_TS;
    },
    check: (text) => {
      if (new RegExp(`set_config\\(\\s*'${RLS_SYSTEM}'\\s*,\\s*'on'|SET\\s+LOCAL\\s+${RLS_SYSTEM}\\s*(=|TO)\\s*'?on`, 'i').test(text)) return [];
      return grepLines(DATA_DML_RLS, { transform: (ln) => ln.replace(/--.*$/, '') })(text);
    },
  },
  {
    id: 'repo-subclass',
    rule: 'BB-5: `extends TenantScopedRepository` chỉ ở file trong danh sách cho phép (lớp con có client trần qua `prisma` protected)',
    source: 'Review vòng 2 R2-5, ADR-100',
    // Thêm lớp con = thêm file vào đây kèm lý do + review mọi truy vấn của nó đều lọc tenant_id.
    include: (f) => isSrc(f) && !REPO_SUBCLASS_ALLOWED.includes(f),
    // Chỉ khai báo lớp (không bắt ràng buộc generic `<T extends TenantScopedRepository>` của chính repo).
    // R3-3: cả bí danh — `import { TenantScopedRepository as Base }`, `const B = TenantScopedRepository`.
    check: repoSubclassCheck,
  },
  {
    id: 'sig-compare',
    rule: 'Chữ ký: không `===`/`!==` trên dòng có signature|hmac|digest trong libs/providers/src (dùng timingSafeEqual)',
    source: 'CLAUDE.md, ADR-058',
    include: (f) => isSrc(f) && f.startsWith('libs/providers/src/'),
    // Bỏ phép kiểm KIỂU (`typeof x === 'string'`) và so với null/undefined: không phải so sánh giá trị bí mật.
    check: grepLines(/(signature|hmac|digest)[\s\S]*(===|!==)|(===|!==)[\s\S]*(signature|hmac|digest)/i, {
      skipComments: true,
      transform: (ln) =>
        ln
          .replace(/typeof\s+[\w.$[\]'"]+\s*(===|!==)\s*['"]\w+['"]/g, '')
          .replace(/(===|!==)\s*(null|undefined)\b/g, ''),
    }),
  },
  {
    id: 'topology',
    rule: 'Topology RabbitMQ: `assertQueue`/`assertExchange` chỉ ở libs/messaging/src/topology.ts',
    source: 'CLAUDE.md',
    include: (f) => isSrc(f) && f !== 'libs/messaging/src/topology.ts',
    check: grepLines(/assert(Queue|Exchange)\b/, { skipComments: true }),
  },
  {
    id: 'test-focus-skip',
    rule: 'Test: không `.only(`, `it/test/describe.skip(`, `xit(`/`xdescribe(` (describeDb thì được — L1 bắt skip = 0)',
    source: 'SPEC-verification §3.4',
    include: isSpec,
    check: grepLines(new RegExp(`${ONLY}|${SKIPS}|${XS}`), { skipComments: true }),
  },
  {
    id: 'test-prisma-client',
    rule: 'Test: `new PrismaClient(` chỉ ở libs/database/test/support/test-db.ts',
    source: 'SPEC-verification §4.3',
    include: (f) => (isSpec(f) || /\/test\//.test(f)) && f !== 'libs/database/test/support/test-db.ts',
    check: grepLines(new RegExp(NEW_PRISMA), { skipComments: true }),
  },
  {
    id: 'sim-independent',
    rule: 'Giả lập/sink: tools/* không import gì từ apps/, libs/, @hub',
    source: 'SPEC-verification §5.1',
    include: (f) => f.startsWith('tools/') && /\.(ts|js|mjs|cjs)$/.test(f),
    check: grepLines(/(from\s+|require\(\s*|import\(\s*)['"](@hub\b|(\.\.\/)+(apps|libs)\b)/),
  },
  {
    id: 'test-only-config',
    rule: '`VERIFY_DB_OWNER_URL` / `MAIL_DRIVER=capture` trong src chỉ ở chỗ assert khởi động',
    source: 'SPEC-verification §4',
    include: (f) => isSrc(f) && f !== 'libs/common/src/test-only-config.ts',
    check: grepLines(new RegExp(OWNER_URL), { skipComments: true }),
    exceptions: [
      {
        file: 'libs/common/src/mail/index.ts',
        reason: 'Chính là nơi CÀI ĐẶT driver capture (SPEC-verification §4.2, AU2); production + capture bị chặn lúc khởi động ở test-only-config.ts. Không chỗ nào khác được chọn capture.',
      },
    ],
  },
  {
    id: 'verify-no-bypass',
    rule: 'Không `--no-' + 'verify` / `--passWith' + 'NoTests` trong script verify, package.json, workflow',
    source: 'SPEC-verification §3.4',
    include: (f) => f === 'package.json' || /^verify\/.*\.(ts|json)$/.test(f) || /^\.github\/workflows\//.test(f),
    check: grepLines(new RegExp(NO_VERIFY)),
  },
  {
    id: 'fixture-account',
    rule: 'Fixture không chứa số tài khoản thật (9–14 chữ số liền) trong tools/hub-sim/fixtures',
    source: 'SPEC-verification §14.3',
    include: (f) => f.startsWith('tools/hub-sim/fixtures/'),
    check: fixtureAccountCheck,
    exceptions: [
      {
        file: 'tools/hub-sim/fixtures/payos/confirm-probe.json',
        match: '"reference":\\s*"TF230204212323"',
        reason:
          'Hằng số CÔNG KHAI trong tài liệu PayOS (bộ mẫu confirm-webhook, payos.vn/docs), không phải số tài khoản thật; nhận diện request kiểm tra đòi đúng nguyên văn — ADR-159. Chỉ dòng `reference` của đúng file này; dãy số khác trong file vẫn đỏ.',
      },
    ],
  },
  {
    id: 'server-lib-subpath',
    rule: 'Src phía server (apps/* trừ web, libs/*): chỉ import barrel `@hub/<lib>`, không subpath `@hub/<lib>/…`',
    // tsconfig paths + jest moduleNameMapper resolve subpath, Node lúc chạy thì không: node_modules/@hub/<lib> trỏ gốc
    // package (không phải dist/), package không khai `exports` → MODULE_NOT_FOUND, hub-api không lên (CI e2e đỏ fa1874c).
    // apps/web dùng alias Next riêng (`@hub/providers/catalog`, E28) nên ngoài phạm vi.
    source: 'ADR-210',
    include: (f) => isSrc(f) && !f.startsWith('apps/web/'),
    check: grepLines(new RegExp(`(\\bfrom\\s+|\\brequire\\(\\s*|\\bimport\\s*\\(?\\s*)['"]${'@h' + 'ub'}/[\\w-]+/`), { skipComments: true }),
  },
  {
    id: 'shop-size',
    rule: 'Tổng apps/shop/src/**/*.ts ≤ 600 dòng',
    source: 'CLAUDE.md, ADR-141, ADR-156',
    include: (f) => /^apps\/shop\/src\/.*\.ts$/.test(f),
    check: () => [],
    checkAll: (files) => {
      const n = files.reduce((sum, f) => sum + f.text.replace(/\r?\n$/, '').split(/\r?\n/).length, 0);
      return n > 600 ? [{ file: 'apps/shop/src', line: n, text: `${n} dòng > 600` }] : [];
    },
  },
];

export function runGates(gates: Gate[], files: string[], read: (f: string) => string): GateResult[] {
  return gates.map((gate) => {
    const violations: GateViolation[] = [];
    const excepted: GateViolation[] = [];
    const scoped = files.filter((f) => gate.include(f));
    if (gate.checkAll) violations.push(...gate.checkAll(scoped.map((file) => ({ file, text: read(file) }))));
    for (const file of scoped) {
      for (const hit of gate.check(read(file), file)) {
        const ex = gate.exceptions?.find((e) => e.file === file && (!e.match || new RegExp(e.match).test(hit.text)));
        if (ex) excepted.push({ file, ...hit, reason: ex.reason });
        else violations.push({ file, ...hit });
      }
    }
    return { gate, violations, excepted };
  });
}
