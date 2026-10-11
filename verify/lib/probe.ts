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
  detail: string[];
}

/** So kết quả test (đã chạy trên code BỊ PHÁ) với kỳ vọng của probe. Tên test khớp theo chuỗi con. */
export function judgeProbe(p: Probe, tests: TestRow[]): ProbeVerdict {
  const detail: string[] = [];
  let ok = true;
  const check = (needle: string, want: 'failed' | 'passed') => {
    const hits = tests.filter((t) => t.name.includes(needle));
    if (hits.length === 0) {
      ok = false;
      detail.push(`✗ ${needle}: không tìm thấy test nào (đổi tên test? suite không chạy?)`);
      return;
    }
    const good = want === 'failed' ? hits.some((t) => t.status === 'failed') : hits.every((t) => t.status === 'passed');
    if (!good) ok = false;
    detail.push(`${good ? '✓' : '✗'} ${needle}: ${hits.map((t) => t.status).join(',')} (mong ${want === 'failed' ? 'ĐỎ' : 'XANH'})`);
  };
  for (const n of p.expectRed ?? []) check(n, 'failed');
  for (const n of p.expectGreen ?? []) check(n, 'passed');
  return { ok, detail };
}

/** BB-n → probe chứng minh "đỏ khi phá" (§8.2). BB-4 không có probe trong spec (hình dạng, không phải nhánh code). */
export const BB_PROBES: Record<string, string[]> = {
  '1': ['P-BB1-01'],
  '2': ['P-BB2-01'],
  '3': ['P-BB3-01', 'P-BB3-02'],
  '4': [],
  '5': ['P-BB5-01', 'P-BB5-02'],
};
