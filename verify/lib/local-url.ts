/**
 * M-3: host được phép cho mọi lệnh KHÔNG phải verify:deployed (đăng ký hàng loạt, bắn webhook, kill container).
 * M-R2-2: tên container compose `hubv-…` chỉ nhận khi là MỘT nhãn DNS (không dấu chấm) — `hubv.evil.com`,
 * `hubv-x.onrender.com` là host công khai, không phải hubv.
 */
export function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return ['localhost', '127.0.0.1', '::1', 'hub-api'].includes(h) || /^hubv-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(h);
  } catch {
    return false;
  }
}

/** Lối vào chạy thẳng (vd `verify:e2e:auth`): URL không local -> báo và thoát 2 TRƯỚC mọi request. */
export function assertLocalOrExit(url: string, what: string): void {
  if (isLocalUrl(url)) return; // KHÔNG có ngoại lệ VERIFY_DEPLOYED: lối vào này xoá khoá Redis + psql của hubv
  console.error(`✗ VERIFY_API_URL=${url} không phải hubv local (localhost/127.0.0.1/::1/hub-api/hubv-*). ${what} chỉ chạy local — dùng npm run verify:deployed cho môi trường thật, hoặc unset VERIFY_API_URL.`);
  process.exit(2);
}
