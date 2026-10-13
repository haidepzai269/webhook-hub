/**
 * PK9: `npm run catalog:build` — kiểm entries/ + entries-pending/ + fixtures/ rồi sinh `catalog.data.ts` (danh mục
 * đã build mà hub-api trả ở `GET /api/v1/catalog`). `--check`: chỉ so, lệch thì thoát 1 (CI / trước commit).
 */
import * as fs from 'fs';
import * as path from 'path';
import { CATALOG_DIR, readCatalogSources, renderCatalogData } from '../catalog-files';

const s = readCatalogSources();
if (s.problems.length > 0) {
  console.error(`Danh mục sai (${s.problems.length}):\n- ${s.problems.join('\n- ')}`);
  process.exit(1);
}
const out = path.join(CATALOG_DIR, 'catalog.data.ts');
const next = renderCatalogData(s.entries);
const cur = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').replace(/\r\n/g, '\n') : '';
if (process.argv.includes('--check')) {
  if (cur !== next) {
    console.error('catalog.data.ts lệch với entries/ — chạy `npm run catalog:build`.');
    process.exit(1);
  }
  console.log(`catalog.data.ts khớp (${s.entries.length} mục).`);
} else {
  fs.writeFileSync(out, next);
  console.log(`Đã build ${s.entries.length} mục -> catalog.data.ts · pending ${s.pending.length} · fixture ${s.fixtures.length}.`);
}
