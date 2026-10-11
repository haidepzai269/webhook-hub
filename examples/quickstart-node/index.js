// Quickstart (docs/QUICKSTART.md): nhận webhook của hub — qua `hub listen` ở máy local, hoặc push thật khi đã deploy.
const http = require('node:http');
const { verifyWebhook, challengeResponse } = require('@hub/sdk');

// Local: secret phiên mà `hub listen` in ra. Deployed: signing secret của endpoint (lấy lúc tạo endpoint).
const SECRET = process.env.HUB_LISTEN_SECRET || process.env.HUB_SIGNING_SECRET;
const PORT = Number(process.env.PORT || 3000);
if (!SECRET) {
  console.error('Set HUB_LISTEN_SECRET (printed by `hub listen`) or HUB_SIGNING_SECRET (deployed endpoint).');
  process.exit(2);
}

http
  .createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/webhooks') return res.writeHead(404).end();
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks); // BYTES gốc: chữ ký tính trên đây, KHÔNG trên JSON đã parse
      if (!verifyWebhook(raw, req.headers, SECRET)) return res.writeHead(401).end('invalid signature');
      let body;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        return res.writeHead(400).end('invalid json');
      }
      const challenge = challengeResponse(body); // hub kiểm endpoint lúc đăng ký -> trả lại challenge
      if (challenge) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(challenge));
      // `body.id` (= header webhook-id) giữ nguyên qua mọi lần gửi lại -> dùng để chống trùng.
      console.log(body.type, body.data?.amount ?? '', body.id);
      res.writeHead(200).end('ok');
    });
  })
  .listen(PORT, () => console.log(`Listening on http://localhost:${PORT}/webhooks`));
