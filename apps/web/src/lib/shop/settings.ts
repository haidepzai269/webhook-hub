// SK3 (SPEC-shop-ket-noi-project §4.4): trang Cài đặt kết nối của Shop — gọi API của apps/shop, KHÔNG gọi hub (BB-1).
import { SHOP_API_URL } from "@/lib/env";

import { buildSettingsBody, type SettingsForm } from "./settings-logic";

export const ADMIN_TOKEN_KEY = "shop:adminToken"; // sessionStorage: chỉ sống trong tab

export class ShopAdminError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> | null,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
  const res = await fetch(`${SHOP_API_URL}${path}`, {
    method,
    cache: "no-store",
    headers: { "Content-Type": "application/json", "x-shop-admin-token": token },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const msg =
      res.status === 404
        ? "Shop chưa bật trang cài đặt (thiếu SHOP_ADMIN_TOKEN trên server)."
        : res.status === 401
          ? "Sai mã quản trị."
          : String(json?.error ?? `Lỗi ${res.status}`);
    throw new ShopAdminError(res.status, msg, json);
  }
  return json as T;
}

export interface FieldView {
  source: "db" | "env" | "none";
  configured?: boolean;
  last4?: string | null;
  value?: string | string[] | null;
  project?: string;
  host?: string;
}
export interface SettingsView {
  fields: Record<string, FieldView>;
  canSave: boolean;
  updatedAt: string | null;
}
export interface HubCheck {
  project: { slug: string; name: string; environment: string };
  serviceName: string;
  scopes: string[];
  sources: { sourceKey: string; provider: string; name: string; isActive: boolean }[] | null;
  sourcesFix?: string;
}
export interface SaveResult {
  saved: string[];
  registration: {
    status: "VERIFIED" | "FAILED" | "SKIPPED";
    error?: string;
    verificationFix?: string | null;
    project?: string;
  };
  settings: SettingsView;
}

export const getSettings = (token: string) => call<SettingsView>("GET", "/settings", token);
export const testHub = (token: string, hubConnectionUrl: string) =>
  call<HubCheck>("POST", "/settings/test-hub", token, { hubConnectionUrl });
export const saveSettings = (token: string, form: SettingsForm) =>
  call<SaveResult>("PUT", "/settings", token, buildSettingsBody(form));
