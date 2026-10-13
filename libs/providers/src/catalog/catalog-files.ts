import * as fs from 'fs';
import * as path from 'path';
import { CATALOG_ID_RE, entryProblems, validateCatalog } from './catalog';
import { identify } from './identify';
import { CatalogEntry } from './types';

/**
 * PK9: phần ĐỌC ĐĨA của danh mục (chỉ dùng ở công cụ build + test, không ở hub-api lúc chạy): đọc `entries/`,
 * `entries-pending/`, `fixtures/`, kiểm luật cần đĩa (≥ 1 fixture mỗi mục, dòng `# origin`), sinh `catalog.data.ts`,
 * và chạy bài A (§13) trên mọi fixture.
 */
export const CATALOG_DIR = __dirname;
export const FIXTURE_ORIGIN_RE = /^# origin: (official|constructed); source: (https?:\/\/\S+)\s*$/;

export interface Fixture {
  entryId: string;
  file: string;
  origin: 'official' | 'constructed';
  source: string;
  text: string;
}

export interface PendingEntry {
  id: string;
  name: string;
  aliases: string[];
  confidence: string;
  docs: string;
  blockedBy: string[];
  pendingReason: string;
  handler?: unknown;
}

const readJsonDir = (dir: string): Array<{ file: string; value: any }> =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => ({ file: f, value: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }))
    : [];

export function readFixtures(root = CATALOG_DIR): Fixture[] {
  const dir = path.join(root, 'fixtures');
  if (!fs.existsSync(dir)) return [];
  const out: Fixture[] = [];
  for (const id of fs.readdirSync(dir).sort()) {
    const sub = path.join(dir, id);
    if (!fs.statSync(sub).isDirectory()) continue;
    for (const file of fs.readdirSync(sub).filter((f) => f.endsWith('.http')).sort()) {
      const text = fs.readFileSync(path.join(sub, file), 'utf8');
      const m = FIXTURE_ORIGIN_RE.exec(text.split(/\r?\n/)[0]);
      out.push({ entryId: id, file: `${id}/${file}`, origin: (m?.[1] ?? 'constructed') as Fixture['origin'], source: m?.[2] ?? '', text });
    }
  }
  return out;
}

export interface CatalogSources {
  entries: CatalogEntry[];
  pending: PendingEntry[];
  fixtures: Fixture[];
  problems: string[];
}

/** Đọc + kiểm toàn bộ (gồm luật cần đĩa). `problems` rỗng = build được. */
export function readCatalogSources(root = CATALOG_DIR): CatalogSources {
  const problems: string[] = [];
  const entriesRaw = readJsonDir(path.join(root, 'entries'));
  const pendingRaw = readJsonDir(path.join(root, 'entries-pending'));
  const fixtures = readFixtures(root);

  for (const { file, value } of entriesRaw) {
    problems.push(...entryProblems(value));
    if (`${value?.id}.json` !== file) problems.push(`entries/${file}: tên file phải là <id>.json`);
    const own = fixtures.filter((f) => f.entryId === value?.id);
    if (own.length === 0) problems.push(`${value?.id}: không có fixture nào (fixtures/${value?.id}/*.http)`);
  }
  const ids = new Set<string>();
  for (const { value } of entriesRaw) {
    if (ids.has(value.id)) problems.push(`${value.id}: id trùng`);
    ids.add(value.id);
  }
  for (const { file, value } of pendingRaw) {
    const p = value as PendingEntry;
    if (typeof p.id !== 'string' || !CATALOG_ID_RE.test(p.id) || `${p.id}.json` !== file) problems.push(`entries-pending/${file}: id sai hoặc tên file khác <id>.json`);
    if (typeof p.pendingReason !== 'string' || p.pendingReason.trim() === '') problems.push(`${p.id}: pending thiếu pendingReason`);
    if (!Array.isArray(p.blockedBy) || p.blockedBy.length === 0) problems.push(`${p.id}: pending thiếu blockedBy`);
    if (ids.has(p.id)) problems.push(`${p.id}: vừa ở entries/ vừa ở entries-pending/`);
  }
  for (const f of fixtures) {
    if (!FIXTURE_ORIGIN_RE.test(f.text.split(/\r?\n/)[0])) problems.push(`fixtures/${f.file}: dòng đầu phải là "# origin: official|constructed; source: <url>"`);
    if (!ids.has(f.entryId) && !pendingRaw.some((p) => p.value?.id === f.entryId)) problems.push(`fixtures/${f.file}: không thuộc mục nào`);
  }
  const entries = entriesRaw.map((x) => x.value as CatalogEntry).sort((a, b) => a.id.localeCompare(b.id));
  return { entries, pending: pendingRaw.map((x) => x.value as PendingEntry), fixtures, problems };
}

/** Nội dung `catalog.data.ts` sinh từ `entries/` (đã sắp theo id). */
export function renderCatalogData(entries: CatalogEntry[]): string {
  validateCatalog(entries);
  return [
    '// SINH TỰ ĐỘNG bởi `npm run catalog:build` từ libs/providers/src/catalog/entries/*.json — KHÔNG sửa tay.',
    '// Test [PK:T19] đỏ khi file này lệch với entries/ (quên build lại).',
    "import type { CatalogEntry } from './types';",
    '',
    `export const CATALOG_DATA: CatalogEntry[] = ${JSON.stringify(entries, null, 2)};`,
    '',
  ].join('\n');
}

export interface AcceptanceRow {
  fixture: string;
  entryId: string;
  origin: Fixture['origin'];
  top: string[];
  ok: boolean;
}

/**
 * Bài A (§13, `[PK:T19]`): mọi fixture của mọi mục đã nạp -> `identify({sample})` phải đưa CHÍNH mục đó lên đầu, hoặc
 * một mục cùng `group` cùng điểm cao nhất (Svix: không chọn bừa).
 */
export function acceptanceA(entries: readonly CatalogEntry[], fixtures: Fixture[]): AcceptanceRow[] {
  const ids = new Set(entries.map((e) => e.id));
  const groupOf = new Map(entries.map((e) => [e.id, e.group]));
  return fixtures
    .filter((f) => ids.has(f.entryId))
    .map((f) => {
      const r = identify({ sample: f.text }, entries);
      const best = r.matches[0]?.score;
      const top = r.matches.filter((m) => m.score === best).map((m) => m.id);
      const g = groupOf.get(f.entryId);
      const first = r.matches[0];
      const ok = !!first && (first.id === f.entryId || (g !== null && g !== undefined && first.group === g && top.includes(f.entryId)));
      return { fixture: f.file, entryId: f.entryId, origin: f.origin, top, ok };
    });
}

/** Bảng hai cột official / constructed (không gộp, §13). */
export function acceptanceReport(rows: AcceptanceRow[]): string {
  const col = (o: Fixture['origin']) => {
    const rs = rows.filter((r) => r.origin === o);
    return `${rs.filter((r) => r.ok).length}/${rs.length}`;
  };
  const lines = ['| Bài A (nhận tên) | official | constructed |', '|---|---|---|', `| đúng mục / nhóm đứng đầu | ${col('official')} | ${col('constructed')} |`];
  const fails = rows.filter((r) => !r.ok);
  if (fails.length > 0) lines.push('', 'Trượt:', ...fails.map((r) => `- ${r.fixture} (${r.origin}): đầu bảng = ${r.top.join(', ') || '(không khớp)'}`));
  return lines.join('\n');
}
