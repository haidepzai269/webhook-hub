/**
 * VF3 (SPEC-verification §5.2, rủi ro §14.3): làm sạch body `real` TRƯỚC khi commit (repo public).
 * Thay trên CHUỖI BYTES, không parse/stringify (giữ nguyên "bytes lạ"):
 *   - mọi dãy 9–14 chữ số (số tài khoản, số thẻ, SĐT…) -> cùng độ dài, chữ số giả tất định;
 *   - giá trị chuỗi của khoá kết thúc bằng `name`/`Name` (counterAccountName, author.name…) -> 'X' cùng độ dài;
 *   - email -> `user@example.com`-dạng cùng tên miền giả.
 * Giữ độ dài để vị trí byte và kiểu trường không đổi. Chữ ký cũ vô nghĩa sau scrub: fixture luôn được KÝ LẠI lúc phát.
 * Trường thời gian (`created`, `timestamp`) không phải dữ liệu cá nhân: số epoch 10 chữ số sau các khoá đó được giữ.
 */
const KEEP_NUMBER_KEYS = /"(created|timestamp|createdAt|updated|updatedAt)"\s*:\s*$/;

export function scrubText(text: string): string {
  let out = '';
  let last = 0;
  const re = /(?<![\d.])\d{9,14}(?![\d.])/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    out += text.slice(last, m.index) + (KEEP_NUMBER_KEYS.test(before) ? m[0] : fakeDigits(m[0]));
    last = m.index + m[0].length;
  }
  out += text.slice(last);
  out = out.replace(/("[A-Za-z_]*[Nn]ame"\s*:\s*")((?:[^"\\]|\\.)*)(")/g, (_s, a: string, v: string, c: string) => a + 'X'.repeat(v.length) + c);
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (e) => {
    const [local] = e.split('@');
    return `${'u'.repeat(Math.max(1, local.length))}@example.test`;
  });
  return out;
}

/** Cùng độ dài, bắt đầu bằng 9 rồi 0…: tất định để scrub hai lần ra cùng kết quả. */
function fakeDigits(s: string): string {
  return ('9' + '0'.repeat(s.length)).slice(0, s.length);
}

/** Còn dãy 9–14 chữ số không thuộc khoá thời gian không — dùng cho test fixture + `scrub --check`. */
export function findSuspiciousNumbers(text: string): string[] {
  const hits: string[] = [];
  const re = /(?<![\d.])\d{9,14}(?![\d.])/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (!KEEP_NUMBER_KEYS.test(before) && !/^90+$/.test(m[0])) hits.push(m[0]);
  }
  return hits;
}
