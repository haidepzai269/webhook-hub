/** M-3: host được phép cho mọi lệnh KHÔNG phải verify:deployed (đăng ký hàng loạt, bắn webhook, kill container). */
export function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return ['localhost', '127.0.0.1', '::1', 'hub-api'].includes(h) || /^hubv[-.]/.test(h);
  } catch {
    return false;
  }
}
