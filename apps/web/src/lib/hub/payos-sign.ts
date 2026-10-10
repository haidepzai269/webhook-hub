/**
 * Ký webhook PayOS ngay trong trình duyệt (S2-4) — đúng thuật toán `createSignatureFromObj` của
 * `@payos/node` (test chéo ở `libs/providers/test/payos-sign.spec.ts`):
 *  1. sắp khoá của `data` theo alphabet;
 *  2. bỏ khoá có giá trị `undefined`; `null`/"null"/"undefined" thành chuỗi rỗng;
 *     mảng -> JSON.stringify (từng phần tử object được sắp khoá);
 *  3. nối `key=value` bằng `&`, HMAC-SHA256 hex với checksum key.
 * Thuần, không phụ thuộc DOM: chỉ cần WebCrypto (`globalThis.crypto.subtle`) — có ở trình duyệt và Node ≥ 19.
 */

function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.keys(obj)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = obj[k];
      return acc;
    }, {});
}

export function payosCanonicalString(data: Record<string, unknown>): string {
  const sorted = sortKeys(data);
  return Object.keys(sorted)
    .filter((k) => sorted[k] !== undefined)
    .map((k) => {
      let value: unknown = sorted[k];
      if (Array.isArray(value)) {
        value = JSON.stringify(
          value.map((v) =>
            v && typeof v === "object" && !Array.isArray(v) ? sortKeys(v as Record<string, unknown>) : v,
          ),
        );
      }
      if (value === null || value === undefined || value === "null" || value === "undefined") value = "";
      return `${k}=${String(value)}`;
    })
    .join("&");
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await globalThis.crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function signPayosData(data: Record<string, unknown>, checksumKey: string): Promise<string> {
  return hmacSha256Hex(checksumKey, payosCanonicalString(data));
}

/**
 * Nhận body PayOS (object có `data`), trả body MỚI với `signature` đã ký lại. Dựng lại body sau khi
 * ký — byte gửi đi là JSON của object này.
 */
export async function signPayosBody(
  body: Record<string, unknown>,
  checksumKey: string,
): Promise<Record<string, unknown>> {
  const data = body.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Body PayOS phải có trường `data` là object");
  }
  const signature = await signPayosData(data as Record<string, unknown>, checksumKey);
  return { ...body, signature };
}
