import { analyzeMap, declaredCodes, expandCodes, scanTags, SourcesConfig } from '../lib/map';

// Mã trong fixture được ghép chuỗi để chính file này không mang tag thật (scanner đọc mọi *.spec.ts).
const tag = (ns: string, code: string) => '[' + ns + ':' + code + ']';

const SPEC_AU = [
  '## 10. Test',
  '| # | Mục | Kỳ vọng |',
  '|---|---|---|',
  '| UA1 | băm | ok |',
  '| UA99 | dòng mới | ok |',
  '## 12. Checklist',
  '- [x] AU1 · [ ] AU2',
].join('\n');

const CONFIG: SourcesConfig = {
  sources: [
    {
      ns: 'AU',
      file: 'auth.md',
      pattern: String.raw`^\|\s*(UA\d+)\s*\|`,
      done: { checklist: String.raw`\[x\] (AU\d+)`, groups: { AU1: 'UA1,UA99' } },
    },
  ],
  inline: [{ ns: 'BB', codes: '1-5', requireTest: false }],
  doneOverrides: [],
  acceptedOrphans: {},
};
const read = (f: string) => (f === 'auth.md' ? SPEC_AU : '');

describe('verify:map', () => {
  it('expandCodes: dải và danh sách', () => {
    expect(expandCodes('U34-U36,U50')).toEqual(['U34', 'U35', 'U36', 'U50']);
    expect(expandCodes('1-3')).toEqual(['1', '2', '3']);
    expect(expandCodes('#5')).toEqual(['#5']);
  });

  it('[VF:VT3] spec có UA99 thuộc story đã [x] mà không test nào mang → đỏ, liệt kê AU:UA99', () => {
    const declared = declaredCodes(CONFIG, read);
    const tags = scanTags([{ file: 'a.spec.ts', text: `it('${tag('AU', 'UA1')} băm', () => {});` }]);
    const r = analyzeMap(declared, tags, CONFIG);
    expect(r.orphans.map((o) => o.key)).toEqual(['AU:UA99']);
    expect(r.ok).toBe(false);
  });

  it('[VF:VT4] test mang AU:UA999 không có trong spec → đỏ "mã ma"', () => {
    const declared = declaredCodes(CONFIG, read);
    const tags = scanTags([
      { file: 'a.spec.ts', text: `it('${tag('AU', 'UA1')} x', f);\nit('${tag('AU', 'UA99')} y', f);\nit('${tag('AU', 'UA999')} z', f);` },
    ]);
    const r = analyzeMap(declared, tags, CONFIG);
    expect(r.ghosts.map((g) => `${g.key}@${g.file}:${g.line}`)).toEqual(['AU:UA999@a.spec.ts:3']);
    expect(r.ok).toBe(false);
  });

  it('mã trùng không đánh dấu (phần a/b) → đỏ; có đánh dấu → được', () => {
    const declared = declaredCodes(CONFIG, read);
    const dup = scanTags([
      { file: 'a.spec.ts', text: `it('${tag('AU', 'UA1')} x', f);\nit('${tag('AU', 'UA99')} y', f);` },
      { file: 'b.spec.ts', text: `it('${tag('AU', 'UA1')} lần nữa', f);` },
    ]);
    expect(analyzeMap(declared, dup, CONFIG).dups.map((d) => d.key)).toEqual(['AU:UA1']);
    const parts = scanTags([
      { file: 'a.spec.ts', text: `it('${tag('AU', 'UA1')} (phần a) x', f);\nit('${tag('AU', 'UA99')} y', f);` },
      { file: 'b.spec.ts', text: `it('${tag('AU', 'UA1')} (phần b) y', f);` },
    ]);
    expect(analyzeMap(declared, parts, CONFIG).ok).toBe(true);
  });

  it('story chưa [x] thì mã được phép mồ côi; acceptedOrphans có lý do thì không đỏ nhưng vẫn liệt kê', () => {
    const notDone = { ...CONFIG, sources: [{ ...CONFIG.sources[0], done: { checklist: String.raw`\[x\] (AU\d+)`, groups: { AU2: 'UA1,UA99' } } }] };
    expect(analyzeMap(declaredCodes(notDone, read), [], notDone).ok).toBe(true);
    const accepted = { ...CONFIG, acceptedOrphans: { 'AU:UA1': 'cần CI thật', 'AU:UA99': 'docker' } };
    const r = analyzeMap(declaredCodes(accepted, read), [], accepted);
    expect(r.ok).toBe(true);
    expect(r.acceptedOrphans.map((o) => o.key)).toEqual(['AU:UA1', 'AU:UA99']);
  });

  it('doneOverrides đánh dấu xong mã của story chưa [x] (MS:U34..U45 làm trong AF:S3-2)', () => {
    const notDone = {
      ...CONFIG,
      sources: [{ ...CONFIG.sources[0], done: { checklist: String.raw`\[x\] (AU\d+)`, groups: { AU2: 'UA1,UA99' } } }],
      doneOverrides: [{ codes: 'AU:UA99', reason: 'làm ở story khác' }],
    };
    const r = analyzeMap(declaredCodes(notDone, read), [], notDone);
    expect(r.orphans.map((o) => o.key)).toEqual(['AU:UA99']);
  });

  it('dòng comment không tính là tag; nhiều mã trên một test được', () => {
    const tags = scanTags([
      { file: 'a.spec.ts', text: `// ${tag('AU', 'UA1')} chỉ là ghi chú\n * ${tag('AU', 'UA1')}\nit('${tag('AU', 'UA1')}${tag('BB', '5')} x', f);` },
    ]);
    expect(tags.map((t) => `${t.key}:${t.line}`)).toEqual(['AU:UA1:3', 'BB:5:3']);
  });
});
