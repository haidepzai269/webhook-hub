/**
 * PK9 / §13 bài A: `npm run verify:catalog` — chạy `identify()` trên MỌI fixture của MỌI mục đã nạp, in bảng hai cột
 * official / constructed + danh sách trượt + mục pending (không tính mẫu số, kèm lý do). Trượt -> thoát 1.
 */
import { CATALOG } from '../catalog';
import { acceptanceA, acceptanceReport, readCatalogSources } from '../catalog-files';

const s = readCatalogSources();
const rows = acceptanceA(CATALOG, s.fixtures);
const kinds = (k: string) => CATALOG.filter((e) => k in e.handler).length;
console.log(`Danh mục: ${CATALOG.length} mục (config ${kinds('config')}, native ${kinds('native')}, unsupported ${kinds('unsupported')}) · pending ${s.pending.length}\n`);
console.log(acceptanceReport(rows));
console.log('\nPending (không tính mẫu số):');
for (const p of s.pending) console.log(`- ${p.id} [${p.blockedBy.join('+')}]: ${p.pendingReason}`);
process.exit(rows.every((r) => r.ok) ? 0 : 1);
