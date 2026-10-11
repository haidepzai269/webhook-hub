"use client";

import { useCallback, useEffect, useState } from "react";

import { credentialError, credentialInputAttrs } from "@/lib/credential-input";
import {
  ADMIN_TOKEN_KEY,
  getSettings,
  type HubCheck,
  type SaveResult,
  type SettingsView,
  saveSettings,
  testHub,
} from "@/lib/shop/settings";
import {
  currentHint,
  emptyForm,
  type SettingsForm as Form,
  parseKeyList,
  suggestSourceKeys,
} from "@/lib/shop/settings-logic";

const box: React.CSSProperties = {
  border: "1px solid #ddd",
  borderRadius: 8,
  padding: 16,
  marginBottom: 16,
  background: "#fff",
};
const hint: React.CSSProperties = { fontSize: 13, color: "#666", margin: "4px 0 0" };
const SOURCE_LABEL = { db: "đã lưu ở trang này", env: "env của server", none: "chưa có" } as const;

function readToken(): string {
  try {
    return sessionStorage.getItem(ADMIN_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function toError(e: unknown): { msg: string; fix?: string } {
  const err = e as { message?: string; body?: { fix?: unknown } | null };
  return { msg: err.message ?? String(e), fix: typeof err.body?.fix === "string" ? err.body.fix : undefined };
}

/** SK3: 3 bước — hub (connection string + nguồn tin cậy), PayOS (tạo link), VietQR (tuỳ chọn) — rồi "Lưu và kết nối". */
export function SettingsForm() {
  const [token, setToken] = useState("");
  const [view, setView] = useState<SettingsView | null>(null);
  const [form, setForm] = useState<Form>(emptyForm());
  const [check, setCheck] = useState<HubCheck | null>(null);
  const [manualKeys, setManualKeys] = useState("");
  const [busy, setBusy] = useState<"" | "load" | "test" | "save">("");
  const [error, setError] = useState<{ msg: string; fix?: string } | null>(null);
  const [result, setResult] = useState<SaveResult | null>(null);

  const fail = (e: unknown) => setError(toError(e));

  const load = useCallback(async (t: string) => {
    if (!t) return;
    setBusy("load");
    setError(null);
    try {
      const v = await getSettings(t);
      setView(v);
      const keys = v.fields.paymentSourceKeys?.value;
      setForm((f) => ({ ...f, paymentSourceKeys: Array.isArray(keys) ? keys : [] }));
      setManualKeys(Array.isArray(keys) ? keys.join(", ") : "");
      try {
        sessionStorage.setItem(ADMIN_TOKEN_KEY, t);
      } catch {
        /* tab không cho lưu: chỉ phải nhập lại */
      }
    } catch (e) {
      setView(null);
      setError(toError(e));
    } finally {
      setBusy("");
    }
  }, []);

  useEffect(() => {
    const t = readToken();
    setToken(t);
    void load(t);
  }, [load]);

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const runTest = async () => {
    setBusy("test");
    setError(null);
    setCheck(null);
    try {
      const c = await testHub(token, form.hubConnectionUrl.trim());
      setCheck(c);
      if (c.sources)
        setForm((f) => ({ ...f, paymentSourceKeys: suggestSourceKeys(c.sources ?? [], f.paymentSourceKeys) }));
    } catch (e) {
      fail(e);
    } finally {
      setBusy("");
    }
  };

  const save = async () => {
    setBusy("save");
    setError(null);
    setResult(null);
    try {
      // Nguồn tin cậy chỉ gửi khi vừa Kiểm tra hub (không thì giữ nguyên cái đang dùng).
      const keys = !check ? [] : check.sources ? form.paymentSourceKeys : parseKeyList(manualKeys);
      const r = await saveSettings(token, { ...form, paymentSourceKeys: keys });
      setResult(r);
      setView(r.settings);
      setForm((f) => ({ ...emptyForm(), paymentSourceKeys: f.paymentSourceKeys })); // bí mật không ở lại trong ô
    } catch (e) {
      fail(e);
    } finally {
      setBusy("");
    }
  };

  const toggleKey = (k: string) =>
    setForm((f) => ({
      ...f,
      paymentSourceKeys: f.paymentSourceKeys.includes(k)
        ? f.paymentSourceKeys.filter((x) => x !== k)
        : [...f.paymentSourceKeys, k],
    }));
  const hub = view?.fields.hubConnectionUrl;

  const secretInput = (k: keyof Form, label: string, explain: string) => (
    <div className="mb-3">
      <label className="form-label fw-semibold" htmlFor={credentialInputAttrs("shop", k, true).id}>
        {label}
      </label>
      <input
        {...credentialInputAttrs("shop", k, true)}
        className="form-control"
        value={form[k] as string}
        onChange={set(k)}
      />
      {credentialError(label, form[k] as string) && (
        <p className="text-danger small mb-0">{credentialError(label, form[k] as string)}</p>
      )}
      <p style={hint}>
        {explain} · {currentHint(view?.fields[k])}
      </p>
    </div>
  );
  const plainInput = (k: keyof Form, label: string, placeholder: string) => (
    <div className="col-md-4 mb-3">
      <label className="form-label fw-semibold" htmlFor={`st-${k}`}>
        {label}
      </label>
      <input
        id={`st-${k}`}
        className="form-control"
        value={form[k] as string}
        placeholder={(view?.fields[k]?.value as string) || placeholder}
        onChange={set(k)}
      />
    </div>
  );

  return (
    <main className="container py-5" style={{ maxWidth: 820 }}>
      {/* autoComplete off + tên ô riêng: trình duyệt không tự điền đăng nhập đã lưu vào ô khoá (lỗi production). */}
      <form autoComplete="off" onSubmit={(e) => e.preventDefault()}>
        <h1 className="mb-2" style={{ fontSize: 28 }}>
          Cài đặt kết nối của Shop
        </h1>
        <p style={hint}>
          Cắm Shop vào project hub của bạn — không cần sửa env hay deploy lại. Chưa có key? Vào console hub:{" "}
          <a href="/dashboard/api-keys" target="_blank" rel="noreferrer">
            API key
          </a>{" "}
          (tạo key, copy HUB_URL) và{" "}
          <a href="/dashboard/sources" target="_blank" rel="noreferrer">
            Nguồn › Kết nối PayOS
          </a>
          .
        </p>

        <section style={{ ...box, marginTop: 16 }}>
          <label className="form-label fw-semibold" htmlFor="shop-admin-token">
            Mã quản trị (SHOP_ADMIN_TOKEN)
          </label>
          <div className="d-flex gap-2">
            <input
              {...credentialInputAttrs("shop", "adminToken", true)}
              className="form-control"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <button type="button" className="btn btn-dark" disabled={!token || busy !== ""} onClick={() => load(token)}>
              {busy === "load" ? "Đang mở…" : "Mở"}
            </button>
          </div>
          <p style={hint}>Chỉ giữ trong tab này (sessionStorage). Đóng tab là phải nhập lại.</p>
        </section>

        {error && (
          <div className="alert alert-danger" role="alert">
            ❌ {error.msg}
            {error.fix && <div className="mt-1 small">Cách sửa: {error.fix}</div>}
          </div>
        )}

        {view && (
          <>
            <section style={box}>
              <h2 style={{ fontSize: 20 }}>Bước 1 · Kết nối hub</h2>
              <p style={hint}>
                Hiện tại:{" "}
                {hub?.configured
                  ? `project ${hub.project ?? "?"} trên ${hub.host ?? "?"}, key …${hub.last4 ?? "****"} (${SOURCE_LABEL[hub.source]})`
                  : "chưa nối hub"}
              </p>
              <label className="form-label fw-semibold mt-2" htmlFor="shop-hub-connection-url">
                HUB_URL (connection string)
              </label>
              <div className="d-flex gap-2">
                <input
                  {...credentialInputAttrs("shop", "hubConnectionUrl", true)}
                  className="form-control font-monospace"
                  placeholder="hubs://hk_test_…@host/project"
                  value={form.hubConnectionUrl}
                  onChange={set("hubConnectionUrl")}
                />
                <button
                  type="button"
                  className="btn btn-outline-dark"
                  disabled={!form.hubConnectionUrl.trim() || busy !== ""}
                  onClick={runTest}
                >
                  {busy === "test" ? "Đang kiểm…" : "Kiểm tra"}
                </button>
              </div>
              <p style={hint}>
                Dán phần sau “HUB_URL=” trong hộp “Chỉ hiện một lần” của console. Để trống = giữ hub hiện tại.
              </p>
              {check && (
                <div className="mt-3">
                  <p className="mb-2">
                    ✅ Đã nối project <b>{check.project.name}</b> (<code>{check.project.slug}</code>) với tư cách
                    service <b>{check.serviceName}</b> · scope: {check.scopes.join(", ")}
                  </p>
                  {check.sources ? (
                    <>
                      <p className="mb-1 fw-semibold">
                        Nguồn thanh toán tin cậy (Shop chỉ cộng tiền từ các nguồn tick):
                      </p>
                      {check.sources.length === 0 && (
                        <p style={hint}>Project chưa có source nào — tạo ở console › Nguồn.</p>
                      )}
                      {check.sources.map((s) => (
                        <label key={s.sourceKey} className="d-flex gap-2 align-items-center">
                          <input
                            type="checkbox"
                            checked={form.paymentSourceKeys.includes(s.sourceKey)}
                            onChange={() => toggleKey(s.sourceKey)}
                          />
                          {s.name} <span className="badge bg-secondary">{s.provider}</span>{" "}
                          <code style={{ fontSize: 12 }}>{s.sourceKey}</code>
                          {!s.isActive && <small className="text-danger">(đang tắt)</small>}
                        </label>
                      ))}
                    </>
                  ) : (
                    <>
                      <label className="form-label fw-semibold" htmlFor="st-keys">
                        sourceKey của nguồn thanh toán (cách nhau dấu phẩy)
                      </label>
                      <input
                        id="st-keys"
                        className="form-control font-monospace"
                        value={manualKeys}
                        onChange={(e) => setManualKeys(e.target.value)}
                      />
                      <p style={hint}>{check.sourcesFix}</p>
                    </>
                  )}
                </div>
              )}
            </section>

            <section style={box}>
              <h2 style={{ fontSize: 20 }}>Bước 2 · PayOS (để tạo link thanh toán)</h2>
              <p className="small">
                Đây là khoá để Shop <b>tạo link thanh toán</b>. Hub giữ riêng khoá của nó để <b>nhận webhook</b>{" "}
                (ADR-157). Checksum key ở đây phải là CÙNG kênh PayOS với source PayOS bên hub — khác là webhook sẽ bị
                hub từ chối (401). Đối chiếu 4 ký tự cuối với source ở console.
              </p>
              {secretInput("payosClientId", "Client ID", "x-client-id của kênh PayOS")}
              {secretInput("payosApiKey", "API key", "x-api-key — gọi API tạo link")}
              {secretInput("payosChecksumKey", "Checksum key", "ký request tạo link, kiểm chữ ký phản hồi")}
            </section>

            <section style={box}>
              <h2 style={{ fontSize: 20 }}>Bước 3 · VietQR chuyển khoản (tuỳ chọn)</h2>
              <p style={hint}>
                Tài khoản nhận tiền cho cách “Chuyển khoản ngân hàng” (SePay xác nhận). Để trống = giữ nguyên.
              </p>
              <div className="row mt-2">
                {plainInput("bankCode", "Mã ngân hàng", "VD: MB")}
                {plainInput("bankAccount", "Số tài khoản", "")}
                {plainInput("bankAccountName", "Tên chủ tài khoản", "VD: NGUYEN VAN A")}
              </div>
            </section>

            {!view.canSave && (
              <div className="alert alert-warning">
                Server chưa có SHOP_SETTINGS_KEY nên chưa lưu được. Đặt biến này trên Render rồi deploy lại một lần.
              </div>
            )}
            <button
              type="button"
              className="btn btn-danger btn-lg"
              disabled={
                busy !== "" ||
                !view.canSave ||
                (["payosClientId", "payosApiKey", "payosChecksumKey"] as const).some((k) =>
                  credentialError("", form[k]),
                )
              }
              onClick={save}
            >
              {busy === "save" ? "Đang lưu và đăng ký endpoint…" : "Lưu và kết nối"}
            </button>

            {result && (
              <div
                className={`alert mt-3 ${result.registration.status === "VERIFIED" ? "alert-success" : "alert-warning"}`}
                role="status"
              >
                Đã lưu: {result.saved.join(", ") || "(không đổi gì)"}.
                <br />
                {result.registration.status === "VERIFIED" ? (
                  <>
                    ✅ Endpoint của Shop đã VERIFIED trong project {result.registration.project}. Mua thử món 5.000đ
                    được rồi.
                  </>
                ) : result.registration.status === "SKIPPED" ? (
                  <>⚠️ {result.registration.error}</>
                ) : (
                  <>
                    ❌ Đăng ký endpoint thất bại: {result.registration.error}
                    {result.registration.verificationFix && (
                      <div className="small mt-1">Cách sửa: {result.registration.verificationFix}</div>
                    )}
                  </>
                )}
              </div>
            )}
          </>
        )}
      </form>
    </main>
  );
}
