/**
 * npm run adr:new -- "<tiêu đề>" [--dry]  (ADR-267)
 * Lấy số kế tiếp = max(README, docs/adr/NNNN-*.md) + 1, tạo docs/adr/NNNN-<slug>.md từ mẫu 3 dòng, in đường dẫn.
 * --dry: chỉ in đường dẫn và nội dung, không ghi file.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'docs', 'adr');

export function slugify(title: string): string {
  return (
    title
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || 'adr'
  );
}

export function nextAdrNumber(dir: string): number {
  let max = 0;
  const readme = path.join(dir, 'README.md');
  if (fs.existsSync(readme)) for (const m of fs.readFileSync(readme, 'utf8').matchAll(/^## ADR-(\d+)/gm)) max = Math.max(max, Number(m[1]));
  for (const f of fs.readdirSync(dir)) {
    const m = /^(\d{4})-.+\.md$/.exec(f);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const title = args.filter((a) => a !== '--dry').join(' ').trim();
  if (!title) {
    console.error('Dùng: npm run adr:new -- "<tiêu đề>" [--dry]');
    process.exit(2);
  }
  const n = nextAdrNumber(DIR);
  const num = String(n).padStart(4, '0');
  const file = path.join(DIR, `${num}-${slugify(title)}.md`);
  const today = new Date().toISOString().slice(0, 10);
  const body = `# ADR-${n} — ${title} (${today})\n\n**Vấn đề:** ...\n\n**Chọn:** ...\n\n**Đánh đổi:** ...\n`;
  if (dry) console.log(body);
  else fs.writeFileSync(file, body, { flag: 'wx' });
  console.log(path.relative(ROOT, file));
}
