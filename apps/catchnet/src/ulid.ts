/** ULID (26 ký tự Crockford base32: 10 thời gian + 16 ngẫu nhiên). Khớp `ID_RE` của hub (`[0-9A-Za-z]{1,64}`). */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(nowMs: number = Date.now()): string {
  let t = Math.floor(nowMs);
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rnd = new Uint8Array(16);
  crypto.getRandomValues(rnd);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += ALPHABET[rnd[i] & 31];
  return time + rand;
}
