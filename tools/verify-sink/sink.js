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
 */
const http = require('http');

function createSink(opts = {}) {
  const slowMs = opts.slowMs ?? 30_000;
  const max = opts.max ?? 5000;
  /** @type {Array<{at:string,method:string,path:string,query:Record<string,string>,headers:Record<string,string>,body:string}>} */
  let requests = [];

  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://sink');
    const json = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname === '/health') return json(200, { ok: true });
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
      requests.push({
        at: new Date().toISOString(),
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body,
      });
      if (requests.length > max) requests.shift();

      const mode = url.searchParams.get('mode');
      if (mode === 'fail') return json(500, { error: 'sink_mode_fail' });
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
      reply();
    });
  });
}

module.exports = { createSink };
