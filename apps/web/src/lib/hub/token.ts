// JWT admin nằm ở localStorage (giữ key cũ). Server không đọc được → auth guard ở client (SPEC-A ràng buộc).
const TOKEN_KEY = "hub_jwt_token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // private mode / storage bị chặn — phiên chỉ sống tới khi reload
  }
}

export function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // như trên
  }
}
