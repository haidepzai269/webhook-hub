import { bbLayerCell, LastRun, recordRun } from '../lib/last-run';

/** M-R2-1 (REVIEW-VF-R2): commit + thời điểm gắn với TỪNG tầng trong `.last-run.json`, không một commit cho cả file. */
describe('verify/.last-run.json — commit theo tầng (M-R2-1)', () => {
  // Tag ghép chuỗi để verify:map không coi dòng fixture này là một test mang mã bất biến.
  const BB2 = '[' + 'BB:2]';
  const layer = (pass: number, name = `x ${BB2} y`) => ({ pass, fail: 0, skip: 0, ms: 1, tests: [{ name, file: 'f', status: 'passed' as const }] });

  it('VF6 (M-R2-1): chaos ở commit A, rồi verify:unit ở B -> L3 vẫn mang commit A; verify:bb cảnh báo KHÁC HEAD', () => {
    let last: LastRun = { layers: {} };
    last = recordRun(last, { L3: layer(6) }, 'aaaaaaa', '2026-10-11T01:00:00.000Z');
    last = recordRun(last, { L0: layer(800, 'khác') }, 'bbbbbbb', '2026-10-11T02:00:00.000Z');
    expect(last.layers.L3).toMatchObject({ commit: 'aaaaaaa', at: '2026-10-11T01:00:00.000Z', pass: 6 });
    expect(last.layers.L0).toMatchObject({ commit: 'bbbbbbb', at: '2026-10-11T02:00:00.000Z' });
    const cell = bbLayerCell('L3', last, '2', 'bbbbbbb');
    expect(cell).toMatch(/L3 1\/1 pass/);
    expect(cell).toMatch(/@aaaaaaa, KHÁC HEAD bbbbbbb/);
    expect(bbLayerCell('L3', last, '2', 'aaaaaaa')).toMatch(/@aaaaaaa\)/);
    expect(bbLayerCell('L3', last, '2', 'aaaaaaa')).not.toMatch(/KHÁC HEAD/);
  });

  it('VF6 (M-R2-1): tầng ghi theo định dạng cũ (không có commit riêng) -> không mượn commit cấp file, báo "commit không rõ"', () => {
    const last = { at: 'x', commit: 'bbbbbbb', layers: { L2: { ...layer(25), at: '2026-10-10T00:00:00.000Z' } } } as unknown as LastRun;
    const cell = bbLayerCell('L2', last, '2', 'bbbbbbb');
    expect(cell).not.toMatch(/@bbbbbbb\)/);
    expect(cell).toMatch(/commit không rõ/);
  });

  it('VF6 (M-R2-1): tầng chưa chạy hoặc không có test mang tag bất biến n -> null', () => {
    const last = recordRun({ layers: {} }, { L2: layer(1) }, 'a', 't');
    expect(bbLayerCell('L3', last, '2', 'a')).toBeNull();
    expect(bbLayerCell('L2', last, '4', 'a')).toBeNull();
  });
});
