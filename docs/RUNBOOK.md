# RUNBOOK — chạy bộ kiểm chứng

> Nguồn: SPEC-verification §10 (VF8). Mọi lệnh chạy ở **gốc repo**, Git Bash trên Windows hoặc shell Linux/macOS.
> Số liệu báo cáo lấy ở LOCAL (ADR-019) — không bao giờ đo hiệu năng trên Render/Neon/Upstash/CloudAMQP.

## 1. Admin

```bash
npm run verify:up && npm run verify   # hệ thống còn đúng không? L0 + L1 + L2 (~10 phút)
npm run verify:chaos                  # L3: kill api/worker, restart rabbit, tắt/xả Redis, pause Postgres (~6 phút)
npm run verify:bb                     # bảng 5 bất biến cho chương Kiểm thử (test xanh + probe đỏ)
npm run verify:probe -- --all         # mọi probe §6.3 (~2–3 phút/probe; nightly trên CI)
npm run demo:rehearse                 # tập dượt 14 bước bấm giờ → verify/results/rehearsal-<ngày>.md
```

| Lệnh | Tầng | Cần gì | Thời gian |
|---|---|---|---|
| `npm run verify:unit` | L0 | Node | ~1 phút |
| `npm run verify:db` | L1 | `verify:up` (Postgres/Redis của hubv) | ~3 phút |
| `npm run verify:e2e [-- --tag smoke]` | L2 | `verify:up` (đủ stack hubv + sink + mail capture) | ~2,5 phút (smoke ~40 s) |
| `npm run verify:chaos [-- --tag chaos-worker]` | L3 | `verify:up`; được kill container **hubv** | ~6 phút |
| `npm run verify` | L0+L1+L2 | | ~7 phút |
| `npm run verify:all` | L0→L3 | | ~13 phút |
| `npm run verify:map` | — | | sinh `docs/TEST-MAP.md` |
| `npm run verify:gates` | — | | grep gác cổng §7.3 |
| `npm run hub-sim -- list \| send <provider/case> --to <url>` | — | | bộ giả lập provider ký độc lập |
| `bash scripts/e2e-smoke.sh` | L2 | = `verify:e2e -- --tag smoke` | ~40 s |

Tầng thấp đỏ thì tầng cao không chạy. `skip > 0` ở L1/L2/L3 là **đỏ** (xanh vì không chạy gì không phải xanh).

## 2. Dev khác clone repo

Yêu cầu: Node 22, Docker Desktop (≥ 6 GB RAM cho Docker), Git Bash trên Windows.

```bash
git clone <repo> && cd webhook-hub
npm ci
npm run verify:up         # lần đầu build image 5–8 phút; stack "hubv" chạy CẠNH stack dev, cổng +10000
npm run verify            # mong đợi: bảng L0/L1/L2 toàn pass, skip = 0
npm run verify:map        # mở docs/TEST-MAP.md để biết test nào chứng minh gì
```

Muốn **dùng** hub như một dev bên ngoài: xem `docs/QUICKSTART.md` — đăng ký trên web hubv `http://localhost:13000`
(`COMPOSE_PROFILES=web` / `VERIFY_WITH_WEB=1 npm run verify:up`), tạo key, `npx hub listen`.

### Năm lỗi hay gặp

1. **Cổng 15433 (hoặc 14000, 16379…) bị chiếm** — một stack hubv cũ còn chạy: `npm run verify:down` rồi `verify:up`.
2. **`no such file` khi container khởi động** — file `.sh` mang CRLF: `.gitattributes` đã ép LF; checkout lại (`git rm --cached -r . && git reset --hard` trên nhánh sạch) hoặc `dos2unix`.
3. **Docker thiếu RAM: RabbitMQ bị OOM kill** — Docker Desktop ≥ 6 GB, hoặc tắt stack dev khi chạy hubv.
4. **`PRECONDITION_FAILED` do queue cũ** — đổi `x-message-ttl` của queue đã tồn tại: `npm run verify:reset` (xoá volume hubv, không đụng stack dev).
5. **`verify:db` báo `skip > 0`** — chưa `verify:up` (hoặc Postgres hubv chưa healthy): `npm run verify:ps`.

## 3. Trước buổi bảo vệ

Xem `verify/demo/PREFLIGHT.md` (T-1 ngày, T-60', T-10', sự cố) và `verify/demo/steps.yaml` (lời thoại 14 bước).
