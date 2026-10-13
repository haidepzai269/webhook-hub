import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * BP6 (SPEC-ap-luc-nguoc §8, C13, ADR-198): giấy phải khớp code. Tầng retry KHÔNG có jitter (TTL cố định theo queue); lời hứa
 * "jitter ±20%" của phụ lục không được sống lại trong tài liệu sống hay mã. `docs/adr/README.md` (append-only, lịch sử) và
 * `_bmad-output/` (trích nguyên văn phụ lục) nằm ngoài phạm vi — C13.
 */
const ROOT = path.join(__dirname, '../..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');

describe('BP6 — docs-sync', () => {
  it('[BP:T23] không còn "jitter ±20%" trong tài liệu sống + mã; §5.4c có ba dòng "cố tình không làm" mới; §4 ghi TTL cố định + slow-start', () => {
    const files = execFileSync('git', ['ls-files', 'docs', 'apps', 'libs', 'CLAUDE.md'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((f) => f && f !== 'docs/adr/README.md' && /\.(md|ts|tsx|js)$/.test(f) && fs.existsSync(path.join(ROOT, f)));
    expect(files).toEqual(expect.arrayContaining(['docs/ARCHITECTURE.md', 'docs/DEPLOYMENT.md', 'CLAUDE.md']));
    const offenders = files.filter((f) => /jitter\s*±\s*20\s*%/i.test(read(f)));
    expect(offenders).toEqual([]);

    const arch = read('docs/ARCHITECTURE.md');
    const s54c = arch.slice(arch.indexOf('### 5.4c.'), arch.indexOf('### 5.4d.'));
    expect(s54c).toMatch(/Áp lực ngược cả worker theo lỗi của ĐÍCH/);
    expect(s54c).toMatch(/Tách queue theo đích/);
    expect(s54c).toMatch(/Auto-scale theo độ sâu queue/);
    expect(s54c).toMatch(/Slow-start/);
    const s4 = arch.slice(arch.indexOf('## 4. RabbitMQ topology'), arch.indexOf('## 5. Độ tin cậy'));
    expect(s4).toMatch(/\| jitter \| \*\*không có ở tầng retry\*\*.*TTL \*\*cố định\*\*.*slow-start/);
    expect(arch).toMatch(/### 5\.4e\. Áp lực ngược khi hạ tầng của chính hub lỗi/);
    // CLAUDE.md: ngân sách đường hoãn
    expect(read('CLAUDE.md')).toMatch(/đường hoãn\/throttle\/ramp \*\*≤ 1 lệnh, 0 truy vấn DB\*\*/);
  });
});
