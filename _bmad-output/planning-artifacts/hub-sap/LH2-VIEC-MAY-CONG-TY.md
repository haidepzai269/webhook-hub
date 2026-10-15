# LH2 — việc còn phải chạy ở máy công ty

Máy nhà yếu RAM nên chưa chạy các bước dưới đây (luật Admin 2026-10-15). Đã chạy ở máy nhà: vitest `apps/catchnet` 24/24, `tsc` của catchnet, jest `edge-nginx.spec` + `ingest-catchnet.spec` (42 pass, 3 skip vì cần nginx thật), `verify:map` (0 mồ côi, 0 trùng).

**Nhánh:** `feat/lh` · **SHA lúc viết file:** `3163882` (commit chứa file này đứng ngay sau). Chỉ chạy LOCAL. **Cấm** `wrangler deploy`, `wrangler d1 create`, `--remote`, và cấm gọi Cloudflare/Render/Neon thật.

## 1. CI / L0 đầy đủ

```bash
git fetch origin && git checkout feat/lh && npm ci
npm run verify:unit          # L0 toàn repo; jest gốc phải BỎ QUA apps/catchnet
npm run verify:map
cd apps/catchnet && npm ci && npm run typecheck && npm test
```

**ĐẠT khi:**
- `verify:unit` không đỏ mới so với master `d417118`, và không có file nào dưới `apps/catchnet/` trong danh sách jest chạy.
- `verify:map` báo `0 mồ côi · 0 ma · 0 trùng`.
- catchnet: `Tests 24 passed (24)`, `tsc` không lỗi.
- `npm ci` ở gốc không báo lock lệch (workspaces có `"!apps/catchnet"`).

## 2. nginx thật: `geo` dải Cloudflare (R2-L1, ADR-223)

```bash
sudo apt-get install -y nginx gettext-base      # hoặc dùng runner CI: job unit đã cài
EDGE_NGINX_BIN="$(command -v nginx)" npx jest --maxWorkers=2 apps/hub-api/test/edge-nginx.spec.ts
```

**ĐẠT khi:** `edge-nginx.spec` chạy đủ 18 test, **0 skip**, 0 fail. Trong đó `[EG:T9]`/`[EG:T11]` chạy `nginx -t` trên cấu hình có khối `geo $edge_cf_ip` và map khoá `"0:$edge_cf_ip"`.

## 3. workerd thật: `wrangler dev --local` + D1 local

Tạo `apps/catchnet/.dev.vars`. File này đã `.gitignore`. Giá trị chỉ dùng thử, **không** dùng secret thật:

```env
CATCHNET_FORWARD_SECRET=local-test-forward-secret-0123456789abcdef
CATCHNET_ADMIN_TOKEN=local-test-admin-token-0123456789abcdef-x
HUB_ORIGIN_URL=http://127.0.0.1:4010
```

Hub giả in ra `req.url`, header lưới và sha256 của body. Mặc định nó trả 502 (hub vắng); có `?up=1` thì trả 200 accepted:

```bash
node -e "require('http').createServer((q,s)=>{let b=[];q.on('data',c=>b.push(c));q.on('end',()=>{const buf=Buffer.concat(b);console.log(q.method,q.url,JSON.stringify(Object.fromEntries(Object.entries(q.headers).filter(([k])=>k.startsWith('x-catchnet')))),require('crypto').createHash('sha256').update(buf).digest('hex'));const up=process.env.UP==='1';s.writeHead(up?200:502,up?{'x-hub-outcome':'accepted'}:{});s.end(up?'{\"ok\":true}':'down')})}).listen(4010)"
```

Ở terminal khác:

```bash
cd apps/catchnet
npx wrangler d1 migrations apply hub-hooks-db --local
npx wrangler dev --local --test-scheduled --port 8787
```

Ở terminal thứ ba:

```bash
A="Authorization: Bearer local-test-admin-token-0123456789abcdef-x"
curl -s -X PUT localhost:8787/_admin/sources/src_momo -H "$A" -d '{"provider":"momo","ackStatus":204}'
# (a) hub vắng -> ack 204, D1 có 1 dòng
printf '{"a":1}\r\n\xff' | curl -s -o /dev/null -w '%{http_code}\n' --data-binary @- 'localhost:8787/hooks/momo/src_momo?'
npx wrangler d1 execute hub-hooks-db --local --command "SELECT id, target, length(body), hex(body) FROM inbox"
# (b) bật hub (restart hub giả với UP=1) rồi kích cron
curl -s 'localhost:8787/__scheduled?cron=*+*+*+*+*'
npx wrangler d1 execute hub-hooks-db --local --command "SELECT COUNT(*) FROM inbox"
curl -s localhost:8787/_admin/stats -H "$A"
```

**ĐẠT khi:**
- (a) in `204`. D1 có đúng 1 dòng: `target` = `/hooks/momo/src_momo?` (còn dấu `?` đứng một mình), `length(body)` = 10, `hex(body)` = `7B2261223A317D0D0AFF`.
- Lần chuyển tiếp ở (a), hub giả in `POST /hooks/momo/src_momo?`. Dòng request của workerd fetch phải còn `?`. Nếu mất `?` thì T-7 trượt: ghi vào §16 và dừng lại.
- (b) hub giả in `x-catchnet-mode: replay`, cùng `x-catchnet-id` với dòng D1, và sha256 bằng sha256 của 10 byte trên. Sau đó `inbox` = 0 và `stats` = `{"pending":0,"dead":0,"sources":1}`.
- Kiểm chữ ký: lấy các giá trị header mà hub giả in ra, chạy `verifyCatchnetHeaders`/`verifyCatchnetBody` của hub-api với cùng secret. Kết quả phải khác `null` và bằng `true`. Cách nhanh: thêm một ca vào `libs/crypto/test/fixtures/catchnet-vectors.json`, **chỉ khi Admin đồng ý đổi file vector**.
- D1 thật trả BLOB dạng mảng số hay `ArrayBuffer`: dù dạng nào thì `toBytes()` cũng phải ra đúng bytes, tức sha256 ở (b) khớp.

## 4. Ghi kết quả

Ghi giờ chạy, SHA, các số ở trên và mọi chỗ lệch vào §16 của `SPEC-hub-sap.md`, dưới mục "LH2". Không tick LH2 ở §15b trước khi review ĐẠT.
