// LH-S spike (SPEC-hub-sap §7b): ghi mọi request /hooks/* vào D1 nguyên bytes rồi trả 2xx.
// Vứt đi được. KHÔNG verify chữ ký, KHÔNG chuyển tiếp hub — chỉ trả lời câu hỏi "provider có chịu
// gọi *.workers.dev không" và "Cloudflare có đổi bytes/header không".
const MAX_BODY = 1024 * 1024; // 1MB = trần ingest của hub (H10)
const FANOUT_N = 25;          // S6: ≥ 25 subrequest / lần cron
const enc = new TextEncoder();

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

async function sha256Hex(buf) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// So token hằng thời gian: kiểm độ dài trước (timingSafeEqual ném lỗi khi lệch độ dài).
function tokenOk(given, expected) {
  if (!expected || !given) return false;
  const a = enc.encode(given), b = enc.encode(expected);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

async function catchHook(req, env, url) {
  const buf = await req.arrayBuffer(); // bytes thô, KHÔNG parse
  const tooLarge = buf.byteLength > MAX_BODY;
  const headers = Object.fromEntries(req.headers); // header như Worker thấy (gồm cf-*)
  await env.DB.prepare(
    `INSERT INTO hits (kind, received_at, method, url, headers_json, body_len, body_sha256, body, body_too_large)
     VALUES ('hook', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  ).bind(Date.now(), req.method, url.href, JSON.stringify(headers), buf.byteLength,
    await sha256Hex(buf), tooLarge ? null : buf, tooLarge ? 1 : 0).run();
  if (url.pathname.startsWith('/hooks/momo/')) return new Response(null, { status: 204 });
  return json({ ok: true });
}

async function dump(env, url) {
  const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
  const kind = url.searchParams.get('kind');
  const q = kind
    ? env.DB.prepare('SELECT * FROM hits WHERE kind = ?1 ORDER BY id DESC LIMIT ?2').bind(kind, limit)
    : env.DB.prepare('SELECT * FROM hits ORDER BY id DESC LIMIT ?1').bind(limit);
  const { results } = await q.all();
  return json(results.map((r) => ({
    ...r,
    headers: r.headers_json ? JSON.parse(r.headers_json) : null,
    headers_json: undefined,
    body: r.body ? toBase64(new Uint8Array(r.body)) : null, // base64 để so sha256 phía máy dev
  })));
}

// S7: đo Worker → hub. target PHẢI cùng origin với env.HUB_ORIGIN_URL (không thành open proxy).
async function latency(env, url) {
  if (!env.HUB_ORIGIN_URL) return json({ error: 'HUB_ORIGIN_URL chưa đặt' }, 400);
  let target;
  try { target = new URL(url.searchParams.get('target') || env.HUB_ORIGIN_URL); } catch { return json({ error: 'target sai' }, 400); }
  if (target.origin !== new URL(env.HUB_ORIGIN_URL).origin) return json({ error: 'target phải là HUB_ORIGIN_URL' }, 400);
  const n = Math.min(Math.max(Number(url.searchParams.get('n')) || 20, 1), 20);
  const samples = [];
  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    let status;
    try { const r = await fetch(target.href, { method: 'GET' }); status = r.status; await r.arrayBuffer(); }
    catch (e) { status = `ERR ${e.message}`; }
    samples.push({ ms: Date.now() - t0, status });
  }
  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  return json({ target: target.href, n, p50: ms[Math.floor((n - 1) / 2)], max: ms[n - 1], samples });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith('/hooks/')) return await catchHook(req, env, url);
      if (url.pathname === '/_spike/noop') return json({ ok: true });
      if (url.pathname.startsWith('/_spike/')) {
        if (!tokenOk(url.searchParams.get('token'), env.SPIKE_DUMP_TOKEN)) return json({ error: 'unauthorized' }, 401);
        if (url.pathname === '/_spike/dump') return await dump(env, url);
        if (url.pathname === '/_spike/latency') return await latency(env, url);
      }
      return json({ error: 'not_found' }, 404);
    } catch (e) {
      return json({ error: 'spike_failed', message: String(e && e.message) }, 503); // chưa ghi bền → không 2xx
    }
  },

  async scheduled(_event, env) {
    let note = null;
    if (env.SPIKE_FANOUT_URL) {
      const rs = await Promise.allSettled(
        Array.from({ length: FANOUT_N }, () => fetch(env.SPIKE_FANOUT_URL).then(async (r) => { await r.arrayBuffer(); return r.status; })),
      );
      const ok = rs.filter((r) => r.status === 'fulfilled' && r.value < 400).length;
      const errs = rs.filter((r) => r.status === 'rejected').map((r) => String(r.reason && r.reason.message));
      const bad = rs.filter((r) => r.status === 'fulfilled' && r.value >= 400).map((r) => r.value);
      note = JSON.stringify({ fanout: FANOUT_N, ok, fail: FANOUT_N - ok, errors: [...new Set(errs)], badStatus: [...new Set(bad)] });
    }
    await env.DB.prepare(`INSERT INTO hits (kind, received_at, note) VALUES ('cron_tick', ?1, ?2)`)
      .bind(Date.now(), note).run();
  },
};
