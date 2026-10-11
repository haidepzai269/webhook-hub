/**
 * VF4 (SPEC-verification §2 L2, §7.2): kịch bản e2e có TAG, chạy bằng `npm run verify:e2e [-- --tag smoke]`.
 *
 *   tag `smoke`           tập nhỏ thay `scripts/e2e-smoke.sh` (vỏ bash cũ gọi `--tag smoke`)
 *   tag `@deployed-safe`  chạy được vào môi trường deployed (`verify:deployed`): chỉ HTTP công khai, không psql, không
 *                         Redis, không docker, không xoá dữ liệu, không cần mail capture
 *   tag story (`VF3`, `MS:S6`, `AU1`…)  để chạy riêng kịch bản của một story
 *
 * Tên kịch bản mang mã spec (`[VF:VT6] (phần b) …`) → `verify:map` quét như tên test jest.
 */
import { Summary, TestRow } from './results';

export interface Scenario {
  name: string;
  tags: string[];
  fn: () => Promise<void>;
}

export interface ScenarioFile {
  /** Đường dẫn POSIX tương đối gốc repo (để TEST-MAP / last-run trỏ đúng file). */
  file: string;
  scenarios: Scenario[];
  /** Chuẩn bị chung (vd đăng ký user, tạo source) — chạy MỘT lần trước kịch bản đầu tiên được chọn của file. */
  setup?: () => Promise<void>;
  teardown?: () => Promise<void>;
}

/** Lọc theo tag: không truyền tag nào = mọi kịch bản; nhiều tag = HOẶC. `deployed` = chỉ `@deployed-safe`. */
export function selectScenarios(all: Scenario[], tags: string[], deployed: boolean): Scenario[] {
  return all.filter((s) => (!deployed || s.tags.includes('@deployed-safe')) && (tags.length === 0 || tags.some((t) => s.tags.includes(t))));
}

export async function runScenarioFiles(files: ScenarioFile[], tags: string[], deployed: boolean): Promise<Summary> {
  const tests: TestRow[] = [];
  for (const f of files) {
    const chosen = selectScenarios(f.scenarios, tags, deployed);
    if (chosen.length === 0) continue;
    try {
      await f.setup?.();
    } catch (e) {
      // Chuẩn bị hỏng: MỌI kịch bản của file tính FAIL (không phải skip — xanh vì không chạy không phải xanh, H1).
      for (const s of chosen) tests.push({ name: s.name, file: f.file, status: 'failed', failure: `setup: ${(e as Error).message}` });
      console.log(`✗ setup ${f.file}: ${(e as Error).message}`);
      continue;
    }
    for (const s of chosen) {
      const t0 = Date.now();
      try {
        await s.fn();
        tests.push({ name: s.name, file: f.file, status: 'passed' });
        console.log(`✓ ${s.name} (${Date.now() - t0}ms)`);
      } catch (e) {
        tests.push({ name: s.name, file: f.file, status: 'failed', failure: (e as Error).message });
        console.log(`✗ ${s.name}: ${(e as Error).message}`);
      }
    }
    await f.teardown?.().catch((e) => console.log(`  (teardown ${f.file}: ${(e as Error).message})`));
  }
  return {
    pass: tests.filter((t) => t.status === 'passed').length,
    fail: tests.filter((t) => t.status === 'failed').length,
    skip: 0,
    tests,
  };
}

export async function waitFor<T>(what: string, fn: () => Promise<T | undefined | null | false>, timeoutMs = 20_000, everyMs = 300): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`hết ${timeoutMs}ms chờ: ${what}${last ? ` (lỗi cuối: ${(last as Error).message})` : ''}`);
}
