/**
 * VF2 (SPEC-verification §2, §3.3): đếm kết quả jest theo tầng, phán quyết, bánh cóc số test.
 */
import * as path from 'path';

export interface TestRow {
  name: string;
  file: string;
  status: 'passed' | 'failed' | 'skipped';
  failure?: string;
}
export interface Summary {
  pass: number;
  fail: number;
  skip: number;
  tests: TestRow[];
  /** Lý do không chạy được (vd hubv chưa lên). */
  note?: string;
}

export function relFile(abs: string, root: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

export function summarizeJest(json: any, root: string): Summary {
  const tests: TestRow[] = [];
  for (const tr of json.testResults ?? []) {
    const file = relFile(tr.name, root);
    // Suite lỗi biên dịch/import: không có assertionResults nhưng có message → tính 1 fail
    if ((tr.assertionResults ?? []).length === 0 && tr.status === 'failed') {
      tests.push({ name: `(suite) ${file}`, file, status: 'failed', failure: String(tr.message ?? '').slice(0, 2000) });
    }
    for (const a of tr.assertionResults ?? []) {
      const status = a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : 'skipped';
      tests.push({
        name: a.fullName,
        file,
        status,
        failure: status === 'failed' ? (a.failureMessages ?? []).join('\n').slice(0, 2000) : undefined,
      });
    }
  }
  return {
    pass: tests.filter((t) => t.status === 'passed').length,
    fail: tests.filter((t) => t.status === 'failed').length,
    skip: tests.filter((t) => t.status === 'skipped').length,
    tests,
  };
}

/** Không chạy được tầng (hạ tầng chưa lên): mọi test dự kiến tính là skip — để phán quyết đỏ đúng lý do (VT1). */
export function unreachableSummary(expected: number, note = 'hạ tầng không truy cập được'): Summary {
  return { pass: 0, fail: 0, skip: Math.max(expected, 1), tests: [], note };
}

export function layerVerdict(layer: string, s: Summary): string[] {
  const problems: string[] = [];
  if (s.fail > 0) problems.push(`${layer}: ${s.fail} test fail`);
  if (layer !== 'L0' && s.skip > 0) {
    problems.push(`${layer}: skip > 0 ở ${layer} (${s.skip})${s.note ? ` — ${s.note}` : ''}. Xanh vì không chạy gì không phải xanh (H1).`);
  }
  return problems;
}

const BASELINE_LINE = /^Verify-Baseline:\s*giảm\s+(\d+)\s+vì\s+(.+)$/m;

/**
 * Bánh cóc §3.3: pass < baseline → đỏ, trừ khi commit khai `Verify-Baseline: giảm N vì <lý do>` có nêu ADR,
 * và mức giảm thật ≤ N. Tăng → baseline mới (người gọi ghi lại file).
 */
export function ratchet(
  baseline: Record<string, number>,
  layer: string,
  pass: number,
  commitMessage: string,
): { ok: boolean; baseline: Record<string, number>; message: string } {
  const prev = baseline[layer] ?? 0;
  if (pass >= prev) {
    const next = { ...baseline, [layer]: pass };
    return { ok: true, baseline: next, message: pass > prev ? `${layer}: baseline ${prev} → ${pass}` : `${layer}: = baseline ${prev}` };
  }
  const drop = prev - pass;
  const m = BASELINE_LINE.exec(commitMessage);
  if (m && /ADR-\d+/.test(m[2]) && drop <= Number(m[1])) {
    return { ok: true, baseline: { ...baseline, [layer]: pass }, message: `${layer}: giảm ${drop} được khai trong commit (${m[2].trim()})` };
  }
  return {
    ok: false,
    baseline,
    message: `${layer}: số test pass GIẢM ${prev} → ${pass} (−${drop}). Cần dòng "Verify-Baseline: giảm ${drop} vì <lý do> (ADR-xxx)" trong commit (§3.3).`,
  };
}
