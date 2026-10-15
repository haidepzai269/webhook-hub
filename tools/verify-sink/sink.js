'use strict';
/**
 * Sink nhận thử của stack `hubv` (DINH-CHINH-AUTH §8 #6 — thay `scratch/echo.js` của SPEC đa service §7.0).
 * KHÔNG import gì từ apps/ hay libs/: nó đóng vai "service của dev" ở đầu nhận, độc lập với hub.
 *
 *   POST/PUT/... <bất kỳ path>   ghi lại request (bytes thô dạng utf8, header, query) rồi:
 *       body JSON {type:"endpoint.verification", challenge} → 200 {challenge}
 *       ?mode=fail → 500 · ?mode=slow → ngủ slowMs (mặc định 30s) rồi 200 · còn lại → 200 {ok:true}
 *   GET    /_requests[?path=/x]  danh sách request đã ghi (cũ → mới)
 *   DELETE /_requests            xoá hết
 *   GET    /health               200
 *   PUT    /_mode?path=/x        (BP chaos, ADR-193) đặt hành vi THEO PATH lúc chạy, body JSON {mode?: "fail"|"ok", delayMs?: số}
 *                                — "đích chết N phút rồi sống lại" mà không đổi URL endpoint (URL đã xác minh challenge).
 *                                mode "fail" → 500 cho mọi request vào path (VẪN ghi vào _requests: đếm được request đập vào
 *                                đích chết); delayMs → ngủ rồi mới trả (đích chậm, giữ delivery đang bay). Body {} = xoá.
 *   GET    /_mode                các path đang bị đặt · DELETE /_mode xoá hết
 *   /fake-google/*                Google OIDC giả cho e2e đăng nhập Google (fake-google.js, ADR-127) — KHÔNG ghi vào _requests
 *   /_fake/*                      PayOS/Stripe giả cho connector (fake-providers.js, SPEC-ket-noi §4.6) — CÓ ghi vào _requests
 */
const http = require('http');
const { createFakeGoogle } = require('./fake-google');
const { createFakeProviders } = require('./fake-providers');

function createSink(opts = {}) {
  const slowMs = opts.slowMs ?? 30_000;
  const max = opts.max ?? 5000;
  /** @type {Array<{at:string,method:string,path:string,query:Record<string,string>,headers:Record<string,string>,body:string}>} */
  let requests = [];
  /** @type {Map<string,{mode?:string,delayMs?:number}>} hành vi đặt theo path (PUT /_mode) — thắng ?mode= của URL */
  const modes = new Map();
  const fakeGoogle = createFakeGoogle();
  const fakeProviders = createFakeProviders(opts.env);

  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://sink');
    const json = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname === '/health') return json(200, { ok: true });
    if (url.pathname === '/_mode') {
      if (req.method === 'DELETE') {
        modes.clear();
        return json(200, { ok: true });
      }
      if (req.method === 'GET') return json(200, Object.fromEntries(modes));
      const p = url.searchParams.get('path');
      if (!p || !p.startsWith('/')) return json(400, { error: 'path bắt buộc, bắt đầu bằng /' });
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let b = {};
        try {
          b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          return json(400, { error: 'body phải là JSON' });
        }
        const m = {};
        if (b.mode === 'fail') m.mode = 'fail';
        if (Number.isFinite(b.delayMs) && b.delayMs > 0) m.delayMs = Math.min(b.delayMs, 60_000);
        if (Object.keys(m).length) modes.set(p, m);
        else modes.delete(p);
        json(200, { path: p, ...m });
      });
      return;
    }
    if (url.pathname === '/_requests') {
      if (req.method === 'DELETE') {
        requests = [];
        return json(200, { ok: true });
      }
      const p = url.searchParams.get('path');
      return json(200, p ? requests.filter((r) => r.path === p) : requests);
    }

    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (fakeGoogle(req, res, url, body)) return;
      requests.push({
        at: new Date().toISOString(),
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body,
      });
      if (requests.length > max) requests.shift();
      if (fakeProviders(req, res, url, body)) return;

      const forced = modes.get(url.pathname);
      const mode = forced?.mode ?? url.searchParams.get('mode');
      const later = (fn) => (forced?.delayMs ? setTimeout(fn, forced.delayMs) : fn());
      if (mode === 'fail') return later(() => json(500, { error: 'sink_mode_fail' }));
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        /* không phải JSON — vẫn 200 */
      }
      const reply = () =>
        parsed && parsed.type === 'endpoint.verification' && typeof parsed.challenge === 'string'
          ? json(200, { challenge: parsed.challenge })
          : json(200, { ok: true });
      if (mode === 'slow') return setTimeout(reply, slowMs);
      later(reply);
    });
  });
}

module.exports = { createSink };
