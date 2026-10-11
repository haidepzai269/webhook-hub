/**
 * VF6 (SPEC-verification §6.3): probe = đột biến NHẮM ĐÍCH. Áp `find → replace` vào MỘT file trong git worktree
 * tạm, chạy test đích, kiểm `expectRed` ĐỎ (hoặc `expectGreen` còn xanh — probe "sống sót", vd RLS vẫn chặn khi repo
 * quên lọc). `find` không còn khớp → probe MỤC (đỏ) để người sửa code cập nhật probe. Cây làm việc thật không bị sửa.
 */
import * as fs from 'fs';
import * as path from 'path';
import { TestRow } from './results';

export interface Probe {
  id: string;
  claim: string;
  /** Bỏ trống file/find/replace chỉ khi `ownerAsApp` (probe đổi MÔI TRƯỜNG, không đổi code). */
  file: string;
  find: string;
  replace: string;
  /** VT12: chạy test L1 với DATABASE_URL = owner (BYPASSRLS/superuser) — test RLS phải tự đỏ ở assert tiền đề §4.3. */
  ownerAsApp?: boolean;
  expectRed?: string[];
  expectGreen?: string[];
  layer: 'L0' | 'L1';
  /**
   * H-1: regex (chuỗi) mà thông điệp lỗi của test đích PHẢI khớp khi bị phá — chứng minh đỏ ĐÚNG LÝ DO (vd câu assert
   * của chính nhánh bị phá), không phải vì môi trường. Không khai thì vẫn bị chặn bởi WRONG_REASON.
   */
  expectFailure?: string;
  /**
   * L-R2-1: mặc định thông điệp đỏ phải khớp `expectFailure` VÀ không khớp WRONG_REASON. Chỉ probe cố ý đỏ vì lý do
   * kiểu môi trường (vd ECONNREFUSED là chính hành vi cần chứng minh) mới khai cờ này để tắt bộ lọc môi trường.
   */
  allowEnvReason?: boolean;
  /** File test đích (một hoặc nhiều); bỏ trống = mọi file của tầng. */
  testFile?: string | string[];
  note?: string;
}

export function loadProbes(dir: string): Probe[] {
  return fs
    .readdirSync(dir)
    .filter((f) => /^P-.*\.json$/.test(f))
    .sort()
    .map((f) => {
      const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Probe;
      if (`${p.id}.json` !== f) throw new Error(`${f}: id "${p.id}" không khớp tên file`);
      if (!p.expectRed?.length && !p.expectGreen?.length) throw new Error(`${f}: cần expectRed hoặc expectGreen`);
      if (!p.ownerAsApp && (!p.file || typeof p.find !== 'string' || typeof p.replace !== 'string')) throw new Error(`${f}: cần file + find + replace`);
      return p;
    });
}

/**
 * Áp probe lên nội dung file. Worktree trên Windows có thể checkout CRLF (core.autocrlf) trong khi `find` viết LF:
 * so khớp trên bản LF, ghi lại đúng kiểu xuống dòng gốc. `find` phải khớp ĐÚNG MỘT chỗ (khớp 0 = mục, >1 = mơ hồ).
 */
export function applyProbe(text: string, p: Pick<Probe, 'find' | 'replace'>): { ok: true; text: string } | { ok: false; reason: string } {
  const crlf = text.includes('\r\n');
  const lf = crlf ? text.replace(/\r\n/g, '\n') : text;
  const n = lf.split(p.find).length - 1;
  if (n === 0) return { ok: false, reason: 'probe MỤC: `find` không còn khớp — code đã đổi, cập nhật probe' };
  if (n > 1) return { ok: false, reason: `probe mơ hồ: \`find\` khớp ${n} chỗ — viết find dài hơn` };
  const out = lf.replace(p.find, () => p.replace);
  return { ok: true, text: crlf ? out.replace(/\n/g, '\r\n') : out };
}

export interface ProbeVerdict {
  ok: boolean;
  /** Đối chứng không xanh / thiếu: kết quả probe KHÔNG có nghĩa (không phải ✅, cũng không phải "test không bắt được"). */
  invalid: boolean;
  detail: string[];
}

/**
 * H-1: lỗi kiểu MÔI TRƯỜNG — đỏ vì những lý do này không chứng minh test bắt được đột biến. Probe muốn chấp nhận
 * (hiếm) thì phải KHAI `expectFailure` khớp chính lý do đó VÀ `allowEnvReason: true` (L-R2-1).
 */
export const WRONG_REASON = /ECONNREFUSED|ENOTFOUND|Invalid URL|Cannot find module|TypeError|ReferenceError|SyntaxError|Exceeded timeout|Test suite failed to run|P1001|Can't reach database/i;

const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

/**
 * So kết quả test. `control` = lượt chạy test đích trên worktree CHƯA phá (bắt buộc): needle phải XANH ở đó, không
 * thì INVALID. `mutated` = lượt trên code BỊ PHÁ: expectRed cần ≥ 1 test khớp ĐỎ và ĐỎ ĐÚNG LÝ DO (khớp
 * `expectFailure` nếu khai, VÀ không khớp WRONG_REASON trừ khi `allowEnvReason`); expectGreen cần mọi test khớp XANH.
 */
export function judgeProbe(p: Probe, mutated: TestRow[], control: TestRow[] | undefined): ProbeVerdict {
  const detail: string[] = [];
  let ok = true;
  let invalid = false;
  const needles = [...(p.expectRed ?? []), ...(p.expectGreen ?? [])];
  if (!control) {
    return { ok: false, invalid: true, detail: ['✗ INVALID: không có lượt đối chứng trên code chưa phá'] };
  }
  for (const n of needles) {
    const hits = control.filter((t) => t.name.includes(n));
    if (hits.length === 0 || !hits.every((t) => t.status === 'passed')) {
      invalid = true;
      detail.push(`✗ INVALID ${n}: đối chứng (code chưa phá) ${hits.length ? hits.map((t) => t.status).join(',') : 'không thấy test'} — phải XANH trước khi phá`);
    }
  }
  if (invalid) return { ok: false, invalid, detail };
  const want = p.expectFailure ? new RegExp(p.expectFailure, 'i') : null;
  for (const n of p.expectRed ?? []) {
    const hits = mutated.filter((t) => t.name.includes(n));
    if (hits.length === 0) {
      ok = false;
      detail.push(`✗ ${n}: không tìm thấy test nào khi phá (suite không chạy?)`);
      continue;
    }
    const failed = hits.filter((t) => t.status === 'failed');
    if (failed.length === 0) {
      ok = false;
      detail.push(`✗ ${n}: ${hits.map((t) => t.status).join(',')} (mong ĐỎ)`);
      continue;
    }
    const right = failed.filter((t) => {
      const msg = stripAnsi(t.failure ?? '');
      return (!want || want.test(msg)) && (p.allowEnvReason === true || !WRONG_REASON.test(msg));
    });
    if (right.length === 0) {
      ok = false;
      const msg = stripAnsi(failed[0].failure ?? '').replace(/\s+/g, ' ').slice(0, 160);
      const why = want && !failed.some((t) => want.test(stripAnsi(t.failure ?? ''))) ? ` (không khớp expectFailure /${p.expectFailure}/)` : ' (lỗi môi trường)';
      detail.push(`✗ ${n}: đỏ sai lý do${why} — ${msg}`);
      continue;
    }
    detail.push(`✓ ${n}: đối chứng xanh → phá thì đỏ đúng lý do${want ? ` /${p.expectFailure}/` : ''}`);
  }
  for (const n of p.expectGreen ?? []) {
    const hits = mutated.filter((t) => t.name.includes(n));
    const good = hits.length > 0 && hits.every((t) => t.status === 'passed');
    if (!good) ok = false;
    detail.push(`${good ? '✓' : '✗'} ${n}: ${hits.map((t) => t.status).join(',') || 'không thấy'} (mong XANH khi phá)`);
  }
  return { ok, invalid: false, detail };
}

/** BB-n → probe chứng minh "đỏ khi phá" (§8.2). BB-4 không có probe trong spec (hình dạng, không phải nhánh code). */
export const BB_PROBES: Record<string, string[]> = {
  '1': ['P-BB1-01'],
  '2': ['P-BB2-01'],
  '3': ['P-BB3-01', 'P-BB3-02'],
  '4': [],
  '5': ['P-BB5-01', 'P-BB5-02'],
};

/** L-R2-3: pid nhúng trong tên worktree probe (`probe-<id>-<pid>`), từ tên thư mục hoặc một dòng `git worktree list`. */
export function probeWorktreePid(nameOrLine: string): number | null {
  const m = /(?:^|[\\/])probe-P-[^\s\\/]*?-(\d+)(?=\s|$)/.exec(nameOrLine.trim());
  return m ? Number(m[1]) : null;
}

/**
 * L-R2-3: worktree probe tính là SÓT (VT11) khi là của chính lượt này hoặc tiến trình tạo ra nó đã chết. Worktree của
 * một lượt probe KHÁC còn sống (phiên song song) không phải lỗi của lượt này — cùng luật với dọn worktree sót.
 */
export function countsAsLeftoverProbe(nameOrLine: string, selfPid: number, isAlive: (pid: number) => boolean): boolean {
  const pid = probeWorktreePid(nameOrLine);
  if (pid === null) return false;
  return pid === selfPid || !isAlive(pid);
}

/** `process.kill(pid, 0)` không ném = tiến trình còn sống. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
