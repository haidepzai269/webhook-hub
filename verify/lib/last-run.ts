/**
 * `verify/.last-run.json` — kết quả lần chạy cuối của TỪNG tầng. M-R2-1 (REVIEW-VF-R2): commit + thời điểm nằm TRONG
 * mỗi tầng; một lượt `verify:unit` không được "làm mới" commit của kết quả L2/L3 cũ mà nó không chạy lại.
 */
import { TestRow } from './results';

export interface LayerRun {
  pass: number;
  fail: number;
  skip: number;
  ms: number;
  note?: string;
  tests: Omit<TestRow, 'failure'>[];
}
export interface LastRun {
  /** Thời điểm + commit của lượt GHI cuối (bất kỳ tầng nào) — không dùng để gắn cho kết quả một tầng. */
  at?: string;
  commit?: string;
  layers: Record<string, LayerRun & { at: string; commit?: string }>;
}

/** Ghi kết quả các tầng VỪA chạy (giữ nguyên tầng không chạy lần này, kèm commit của chính nó). */
export function recordRun(last: LastRun, results: Record<string, Omit<LayerRun, 'tests'> & { tests: TestRow[] }>, commit: string, at: string): LastRun {
  const out: LastRun = { ...last, at, commit, layers: { ...(last.layers ?? {}) } };
  for (const [layer, r] of Object.entries(results)) {
    out.layers[layer] = { pass: r.pass, fail: r.fail, skip: r.skip, ms: r.ms, note: r.note, at, commit, tests: r.tests.map(({ failure, ...t }) => t) };
  }
  return out;
}

/** Ô L2/L3 của bảng `verify:bb` cho bất biến `n`: số test [BB:n] pass, thời điểm, commit CỦA TẦNG đó, cảnh báo khác HEAD. */
export function bbLayerCell(layer: string, last: LastRun, n: string, head: string): string | null {
  const lay = last.layers?.[layer];
  const rows = (lay?.tests ?? []).filter((t) => String(t.name).includes(`[BB:${n}]`));
  if (!lay || rows.length === 0) return null;
  const pass = rows.filter((t) => t.status === 'passed').length;
  const c = lay.commit;
  const where = !c ? ' @?, commit không rõ (ghi bởi bản cũ) — chạy lại' : c !== head ? ` @${c}, KHÁC HEAD ${head}` : ` @${c}`;
  return `${layer} ${pass}/${rows.length} pass (${String(lay.at ?? '').slice(0, 16)}${where})`;
}
