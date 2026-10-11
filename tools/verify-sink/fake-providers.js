'use strict';
/**
 * Fake provider cho connector của hub (SPEC-ket-noi §4.6, KN2–KN4) — CI không bao giờ gọi PayOS/Stripe thật.
 * KHÔNG import gì từ apps/ hay libs/. hub-api chỉ trỏ vào đây qua PAYOS_FAKE_BASE_URL / STRIPE_FAKE_BASE_URL khi
 * NODE_ENV ≠ production (production có các biến đó -> app không khởi động).
 * Mọi lời gọi tới đây VẪN được ghi vào /_requests (sink ghi trước khi gọi handler) để test kiểm header/body.
 *
 *   POST /_fake/payos/confirm-webhook      header x-client-id / x-api-key, body {webhookUrl}
 *        sai key -> 401 {code:"01"}; đúng -> POST request KIỂM TRA có chữ ký (checksum của fake) vào webhookUrl;
 *        ingest 200 -> {code:"00", data:{webhookUrl, accountName:"CAFE TEST", accountNumber:"0001234", …}}; khác -> 400 {code:"20"}
 *   POST /_fake/payos/send-payment         {webhookUrl?, amount?, description?} -> ký + bắn MỘT giao dịch (mặc định URL đã confirm gần nhất)
 *   POST   /_fake/stripe/v1/webhook_endpoints        (form: url, enabled_events[]) -> {id:"we_test…", secret:"whsec_test…"}
 *   GET    /_fake/stripe/v1/webhook_endpoints/:id    -> {id, url} | 404
 *   DELETE /_fake/stripe/v1/webhook_endpoints/:id    -> {id, deleted:true}
 *
 * Cấu hình (env của sink, giá trị mặc định giả): FAKE_PAYOS_CLIENT_ID, FAKE_PAYOS_API_KEY, FAKE_PAYOS_CHECKSUM_KEY,
 * FAKE_STRIPE_SECRET_KEY (key Stripe chấp nhận; mặc định chấp nhận mọi `sk_test_`/`rk_test_`).
 */
const crypto = require('crypto');
const http = require('http');
const https = require('https');

/** Như `createSignatureFromObj` của SDK PayOS: sort key, null/undefined -> "", nối k=v&…, HMAC-SHA256 hex. */
function payosSign(data, key) {
  const s = Object.keys(data)
    .sort()
    .map((k) => `${k}=${data[k] === null || data[k] === undefined ? '' : data[k]}`)
    .join('&');
  return crypto.createHmac('sha256', key).update(s).digest('hex');
}

/**
 * Giờ VIỆT NAM (+07:00, không đổi giờ mùa) theo khuôn PayOS thật `YYYY-MM-DD HH:mm:ss`, KHÔNG kèm múi giờ — adapter đọc
 * như +07:00 (parseProviderTime). Gửi giờ UTC thì paidAt lệch sớm 7 giờ (REVIEW-P1P2-R2 R2-L3).
 */
function vnLocalTime(now = Date.now()) {
  return new Date(now + 7 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
}

function postJson(target, obj) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(target);
    } catch {
      return resolve({ status: 0, body: 'invalid_url' });
    }
    const body = JSON.stringify(obj);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(10_000, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
    req.end(body);
  });
}

function createFakeProviders(env = process.env) {
  const payos = {
    clientId: env.FAKE_PAYOS_CLIENT_ID || 'fake-payos-client-id',
    apiKey: env.FAKE_PAYOS_API_KEY || 'fake-payos-api-key',
    checksumKey: env.FAKE_PAYOS_CHECKSUM_KEY || 'fake-payos-checksum-key',
  };
  const stripeKey = env.FAKE_STRIPE_SECRET_KEY || '';
  let lastPayosUrl = null;
  let seq = 0;
  const stripeEndpoints = new Map();

  async function payosSend(webhookUrl, data) {
    const payload = { code: '00', desc: 'success', success: true, data, signature: payosSign(data, payos.checksumKey) };
    return postJson(webhookUrl, payload);
  }

  /** Trả true nếu đã xử lý request. */
  return function handle(req, res, url, body) {
    if (!url.pathname.startsWith('/_fake/')) return false;
    const json = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    let parsed = {};
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      parsed = {};
    }

    if (url.pathname === '/_fake/payos/confirm-webhook' && req.method === 'POST') {
      if (req.headers['x-client-id'] !== payos.clientId || req.headers['x-api-key'] !== payos.apiKey) {
        json(401, { code: '01', desc: 'Client id hoặc api key không hợp lệ', data: null });
        return true;
      }
      const webhookUrl = parsed.webhookUrl;
      // Request kiểm tra theo dữ liệu mẫu của tài liệu PayOS (payos.vn/docs/api: "dữ liệu mẫu kèm thông tin giao dịch ngân hàng mẫu").
      const sample = {
        orderCode: 123,
        amount: 3000,
        description: 'VQRIO123',
        accountNumber: '12345678',
        reference: 'TF230204212323',
        transactionDateTime: '2023-02-04 18:25:00',
        currency: 'VND',
        paymentLinkId: '124c33293c43417ab7879e14c8d9eb18',
        code: '00',
        desc: 'Thành công',
        counterAccountBankId: '',
        counterAccountBankName: '',
        counterAccountName: '',
        counterAccountNumber: '',
        virtualAccountName: '',
        virtualAccountNumber: '',
      };
      payosSend(webhookUrl, sample).then((r) => {
        if (r.status !== 200) return json(400, { code: '20', desc: `Webhook url không hợp lệ (ingest trả ${r.status})`, data: null });
        lastPayosUrl = webhookUrl;
        json(200, { code: '00', desc: 'success', data: { webhookUrl, accountName: 'CAFE TEST', accountNumber: '0001234', name: 'CAFE TEST', shortName: 'TEST' } });
      });
      return true;
    }

    if (url.pathname === '/_fake/payos/send-payment' && req.method === 'POST') {
      const target = parsed.webhookUrl || lastPayosUrl;
      if (!target) {
        json(409, { error: 'no_confirmed_webhook' });
        return true;
      }
      seq += 1;
      const data = {
        orderCode: 900000 + seq,
        amount: Number(parsed.amount) || 2000,
        description: parsed.description || `FAKE${seq}`,
        accountNumber: '0001234',
        reference: `FT${Date.now()}${seq}`,
        transactionDateTime: vnLocalTime(),
        currency: 'VND',
        paymentLinkId: crypto.randomBytes(16).toString('hex'),
        code: '00',
        desc: 'Thành công',
      };
      payosSend(target, data).then((r) => json(200, { delivered: r.status, data }));
      return true;
    }

    const stripeBase = '/_fake/stripe/v1/webhook_endpoints';
    if (url.pathname === stripeBase || url.pathname.startsWith(`${stripeBase}/`)) {
      const auth = String(req.headers.authorization || '');
      const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (stripeKey ? key !== stripeKey : !/^(sk|rk)_test_/.test(key)) {
        json(401, { error: { type: 'invalid_request_error', message: 'Invalid API Key provided' } });
        return true;
      }
      const id = url.pathname.slice(stripeBase.length + 1);
      if (!id && req.method === 'POST') {
        const form = new URLSearchParams(body);
        seq += 1;
        const ep = {
          id: `we_test_${seq}_${crypto.randomBytes(4).toString('hex')}`,
          object: 'webhook_endpoint',
          url: form.get('url'),
          enabled_events: form.getAll('enabled_events[]'),
          status: 'enabled',
        };
        stripeEndpoints.set(ep.id, ep);
        json(200, { ...ep, secret: `whsec_test_${crypto.randomBytes(16).toString('hex')}` });
        return true;
      }
      const ep = stripeEndpoints.get(id);
      if (!ep) {
        json(404, { error: { type: 'invalid_request_error', message: `No such webhook endpoint: '${id}'` } });
        return true;
      }
      if (req.method === 'GET') json(200, ep);
      else if (req.method === 'DELETE') {
        stripeEndpoints.delete(id);
        json(200, { id, object: 'webhook_endpoint', deleted: true });
      } else json(405, { error: { message: 'method' } });
      return true;
    }
    json(404, { error: 'unknown_fake_route' });
    return true;
  };
}

module.exports = { createFakeProviders, payosSign, vnLocalTime };
