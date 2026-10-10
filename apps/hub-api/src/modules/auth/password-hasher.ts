import * as bcrypt from 'bcryptjs';

/** SPEC-auth §5.2: bcrypt cost 12 (khoảng 250ms trên máy local). */
export const BCRYPT_COST = 12;

/**
 * Hash giả CỐ ĐỊNH (cost 12, của một chuỗi ngẫu nhiên đã vứt). Email không tồn tại hoặc user chỉ có GitHub
 * vẫn chạy `bcrypt.compare` với hash này: cùng thời gian, cùng body với sai mật khẩu (chống dò email, UA4/TA3).
 */
const DUMMY_HASH = '$2b$12$Cukb/aFMxYZurHnvLWnzXu1ldQ34dqyTCg4IlRbY/Rk8h2eMS2B2.';

/** Điểm gọi bcrypt DUY NHẤT — test spy vào đây (bcryptjs v3 không cho redefine export) để khẳng định compare luôn chạy. */
export const bcryptImpl = {
  hash: (password: string, cost: number): Promise<string> => bcrypt.hash(password, cost),
  compare: (password: string, hash: string): Promise<boolean> => bcrypt.compare(password, hash),
};

export function hashPassword(password: string): Promise<string> {
  return bcryptImpl.hash(password, BCRYPT_COST);
}

/** `.env` qua docker-compose giữ `$$` nếu tiến trình không đi qua compose — chuẩn hoá như AuthService cũ. */
export function normalizeBcryptHash(hash: string): string {
  return hash.replace(/\$\$/g, '$');
}

export async function verifyPassword(password: string, hash: string | null | undefined): Promise<boolean> {
  const real = typeof hash === 'string' && hash.length > 0;
  const ok = await bcryptImpl.compare(password, real ? normalizeBcryptHash(hash) : DUMMY_HASH);
  return real && ok;
}
