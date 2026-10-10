/**
 * VF7 (SPEC-verification §7.3, §3.4): grep gác cổng — chạy trong job CI `unit` và `npm run verify:gates`.
 *
 * Luật KHÔNG được tắt cho xanh. Chỗ code hiện tại vi phạm mà có lý do chính đáng thì vào `exceptions`
 * (file + chuỗi khớp + LÝ DO), được in ra mỗi lần chạy. Ngoại lệ mới phải qua review.
 * Các chuỗi mẫu dưới đây được ghép để chính file này không tự vi phạm khi quét repo.
 */

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

/** Bảng nghiệp vụ / bảng có lối thoát có tên — mọi truy vấn ngoài libs/database/src phải đi qua repo (BB-5). */
const MODELS = ['source', 'sourceSecret', 'rawEvent', 'event', 'destination', 'subscription', 'delivery', 'deliveryAttempt', 'outbox', 'processedMessage', 'auditLog', 'user', 'projectMember', 'authSession', 'emailToken', 'authAudit'];

const ONLY = '\\.on' + 'ly\\(';
const SKIPS = ['it', 'test', 'describe'].map((k) => `\\b${k}\\.sk` + 'ip\\(').join('|');
const XS = '\\bx(it|describe|test)\\(';
const NEW_PRISMA = 'new ' + 'PrismaClient\\(';
const NO_VERIFY = '--no-' + 'verify|--passWith' + 'NoTests';
const RLS_SYSTEM = 'app\\.rls' + '_system';
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
        file: 'apps/hub-api/src/modules/ingest/ingest.service.ts',
        match: 'prisma\\.rawEvent\\.create',
        reason: 'Lưu MẪU request ký sai (REJECTED, S1-4). `raw_events` không có cột tenant_id; `PrismaService.rawEvent` là lối thoát có tên, ghi trong prisma.service.ts. Đường ACCEPTED dùng `tx.rawEvent` trong transaction.',
      },
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
    check: grepLines(/(?<![\d.])\d{9,14}(?![\d.])/),
  },
  {
    id: 'shop-size',
    rule: 'apps/shop/src/main.ts ≤ 300 dòng',
    source: 'CLAUDE.md',
    include: (f) => f === 'apps/shop/src/main.ts',
    check: (text) => {
      const n = text.replace(/\r?\n$/, '').split(/\r?\n/).length;
      return n > 300 ? [{ line: n, text: `${n} dòng > 300` }] : [];
    },
  },
];

export function runGates(gates: Gate[], files: string[], read: (f: string) => string): GateResult[] {
  return gates.map((gate) => {
    const violations: GateViolation[] = [];
    const excepted: GateViolation[] = [];
    for (const file of files) {
      if (!gate.include(file)) continue;
      for (const hit of gate.check(read(file), file)) {
        const ex = gate.exceptions?.find((e) => e.file === file && (!e.match || new RegExp(e.match).test(hit.text)));
        if (ex) excepted.push({ file, ...hit, reason: ex.reason });
        else violations.push({ file, ...hit });
      }
    }
    return { gate, violations, excepted };
  });
}
