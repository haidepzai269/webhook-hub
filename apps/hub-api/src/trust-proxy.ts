import { isIP } from 'net';

/**
 * `TRUST_PROXY` -> giá trị `app.set('trust proxy', …)` của Express (review EG1, nhánh feat/edge).
 * - trống / `0`: không tin X-Forwarded-For (mặc định, như cũ).
 * - `1`: tin đúng một chặng (Render; hub-all + nginx) — như cũ.
 * - số khác: BỎ QUA như cũ (trước đây chỉ `=== '1'` có tác dụng) — không âm thầm tin nhiều chặng hơn.
 * - danh sách IP/CIDR cách nhau dấu phẩy/khoảng trắng (vd `10.250.250.6`): CHỈ tin đúng các địa chỉ đó — compose local cho
 *   service `edge` (nginx), để request gọi thẳng hub-api (k6, cổng 4000) không giả được IP bằng X-Forwarded-For.
 * Phần tử sai khuôn -> ném lỗi (main.ts thoát lúc khởi động, không chạy với cấu hình tin nhầm).
 */
export function parseTrustProxy(raw: string | undefined): number | string[] | undefined {
  const v = (raw ?? '').trim();
  if (v === '' || /^\d+$/.test(v)) return v === '1' ? 1 : undefined;
  const items = v.split(/[\s,]+/).filter(Boolean);
  const bad = items.filter((i) => {
    const [addr, prefix, extra] = i.split('/');
    const fam = isIP(addr);
    if (!fam || extra !== undefined) return true;
    if (prefix === undefined) return false;
    return !/^\d{1,3}$/.test(prefix) || Number(prefix) > (fam === 4 ? 32 : 128) || Number(prefix) === 0;
  });
  if (bad.length) throw new Error(`TRUST_PROXY: phần tử không phải IP/CIDR hợp lệ (/0 bị cấm): ${bad.join(', ')}`);
  return items;
}
