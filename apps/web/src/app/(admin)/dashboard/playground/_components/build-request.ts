import { hmacSha256Hex, signPayosBody } from "@/lib/hub/payos-sign";
import type { Provider } from "@/lib/hub/types";

export interface BuiltRequest {
  headers: Record<string, string>;
  /** Chuỗi gửi đi NGUYÊN VĂN — chữ ký được tính trên chính các byte này (HMAC trên body_raw). */
  body: string;
}

/** SHA-256 của body, định dạng như UUID — ổn định với cùng body, khác nhau khi body khác. */
async function sha256Uuid(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const h = Array.from(new Uint8Array(digest).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Payload mẫu cho từng provider — đủ trường để adapter chuẩn hoá ra sự kiện có nghĩa. */
export function samplePayload(provider: Provider): unknown {
  const now = Date.now();
  switch (provider) {
    case "github":
      return {
        ref: "refs/heads/main",
        repository: { name: "webhook-hub", full_name: "admin/webhook-hub" },
        sender: { login: "tester" },
        head_commit: { id: `c_${now}`, message: "feat: test webhook từ Playground" },
      };
    case "sepay":
      return {
        id: now,
        gateway: "MBBank",
        transactionDate: new Date(now).toISOString(),
        accountNumber: "0987654321",
        code: null,
        content: "Chuyen tien test tu Playground",
        transferType: "in",
        transferAmount: 2000,
        referenceCode: `FT${now}`,
      };
    case "stripe":
      return {
        id: `evt_test_${now}`,
        object: "event",
        type: "payment_intent.succeeded",
        created: Math.floor(now / 1000),
        data: { object: { id: `pi_test_${now}`, object: "payment_intent", amount: 2000, currency: "vnd" } },
      };
    case "payos":
      return {
        code: "00",
        desc: "success",
        success: true,
        data: { orderCode: now, amount: 2000, description: "Test tu Playground", reference: `REF${now}` },
        signature: "(Playground ký lại khi gửi nếu có checksum key)",
      };
  }
}

/**
 * Dựng header xác thực giống hệt provider thật:
 * - GitHub: `X-Hub-Signature-256: sha256=HMAC(secret, rawBody)`
 * - Stripe: `Stripe-Signature: t=<ts>,v1=HMAC(secret, "<ts>.<rawBody>")`
 * - SePay:  `Authorization: Apikey <key>`
 * - PayOS:  chữ ký nằm trong body (`signature` = HMAC trên `data` đã sắp khoá, S2-4) → ký lại rồi
 *           dựng lại body. Body trả về là chuỗi THỰC SỰ được gửi (có thể khác ô nhập).
 * Để trống secret ⇒ cố tình gửi chữ ký sai, để xem hub từ chối (401) thế nào.
 */
export async function buildRequest(provider: Provider, body: string, secret: string): Promise<BuiltRequest> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  switch (provider) {
    case "github":
      headers["X-GitHub-Event"] = "push";
      // Suy ra từ body: gửi lại ĐÚNG body này → cùng delivery id → cùng idempotency key
      // (`github:<delivery>`) → hub nhận ra trùng. GitHub thật cũng giữ nguyên id khi redeliver.
      headers["X-GitHub-Delivery"] = await sha256Uuid(body);
      headers["X-Hub-Signature-256"] = `sha256=${secret ? await hmacSha256Hex(secret, body) : "0".repeat(64)}`;
      break;
    case "stripe": {
      const t = Math.floor(Date.now() / 1000);
      headers["Stripe-Signature"] =
        `t=${t},v1=${secret ? await hmacSha256Hex(secret, `${t}.${body}`) : "0".repeat(64)}`;
      break;
    }
    case "sepay":
      headers.Authorization = `Apikey ${secret || "sai-khoa"}`;
      break;
    case "payos": {
      if (!secret) break; // không có checksum key -> gửi nguyên body (chữ ký cũ/sai -> hub 401)
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new Error("Body PayOS phải là JSON hợp lệ để ký");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Body PayOS phải là object JSON");
      }
      const signed = await signPayosBody(parsed as Record<string, unknown>, secret);
      return { headers, body: JSON.stringify(signed, null, 2) };
    }
  }
  return { headers, body };
}
