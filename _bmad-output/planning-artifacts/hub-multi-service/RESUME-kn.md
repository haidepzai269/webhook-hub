# RESUME — phiên DEV SPEC-ket-noi (KN1 → KN4)

Spec: `SPEC-ket-noi.md` (ADR-138). Câu hỏi cho Admin: `CAN-ADMIN-QUYET-KN.md`. Lệch spec: §11 của spec.

## Cách chạy nhanh
- L0: `npx jest -w 2 <file>` · L1 một file: đặt env như `verify/cli/run.ts db` (DATABASE_URL hub_app của hubv cổng 15433, VERIFY_DB_OWNER_URL owner, MASTER_KEY của `.env.verify`) rồi `jest --runTestsByPath`. Cả tầng: `npm run verify:db`.
- hubv đang được phiên VF dùng cho chaos (Postgres có lúc bị pause → `PrismaClientInitializationError` tạm thời: chạy lại). KHÔNG restart/rebuild hubv.
- Không commit `verify/baseline.json`, `docs/TEST-MAP.md` (sinh tự động, nhiều phiên cùng sửa).

## Sự cố git (2026-10-11)
- `c888ef6` (KN1) dùng `git add` + `git commit` trên **index dùng chung**: nuốt luôn file đã stage của phiên DX (M-1/L-5 + ADR-143) và lại thiếu 3 file của KN1 (`service-resources.controller.ts`, `errors/catalog.ts`, ADR-142) do index bị phiên khác đổi giữa lúc stage và commit → HEAD không biên dịch. Sửa bằng `3955b9f` (commit theo đường dẫn, không amend/reset). HEAD sau sửa: tsc hub-api xanh + L0 kiểm ở worktree tạm.
- Phiên DX viết lại tạm `tenant-scoped.repository.ts` + `docs/ARCHITECTURE.md` để commit theo đường dẫn rồi trả lại; đã kiểm `git diff HEAD`: repo chỉ còn đúng 4 phương thức KN2 của mình (đủ), hunk ARCHITECTURE.md (ghi chú demo §9.1) KHÔNG phải của phiên KN.
- Commit KN2 trở đi: index TẠM (`GIT_INDEX_FILE`, script scratchpad `commit-kn.sh`): file của mình lấy nguyên bản, `docs/adr/README.md` = HEAD + đúng khối ADR của mình (phiên khác đang có ADR chưa commit trong cùng file); sau đó `git reset -q -- <paths>` để index dùng chung khớp HEAD.
- **Luật từ giờ:** chỉ commit bằng `git commit -m … -- <path…>` (chỉ các đường dẫn đó, bất kể index đang có gì). Không `git add` rồi commit trơn.

## SỰ CỐ NGHIÊM TRỌNG (cuối phiên, ~19:00 2026-10-11) — node_modules + apps/ libs/ bị xoá
- Phiên KN tạo worktree tạm `scratchpad/headwt` (kiểm HEAD sau sự cố c888ef6) với **junction** `node_modules` → `C:\webhook-hub
ode_modules`. `git worktree remove --force` đi XUYÊN junction: xoá sạch `node_modules` gốc, và qua các link workspace của npm (`node_modules/@hub/*`, `hub-api`…) xoá luôn file trong `apps/*`, `libs/*`.
- Đã khôi phục: `git checkout HEAD -- apps libs` (mọi file tracked; lúc đó không có file nào trong apps/libs ở trạng thái "M" — chỉ "D"), `npm ci` (946 gói), `prisma generate`, `npm run build:libs`. Sau đó L0 789/0/0, tsc hub-api/web xanh.
- **MẤT KHÔNG KHÔI PHỤC ĐƯỢC:** file KHÔNG tracked bên trong `apps/*` và `libs/*` của mọi phiên (vd file mới chưa `git add`, `.env*` cục bộ trong apps nếu có, `apps/web/.next`), và mọi thay đổi chưa commit trong apps/libs tại thời điểm đó (status ngay trước chỉ còn các file của phiên khác ngoài apps/libs: `verify/lib/probe.ts`, `verify/test/probe.spec.ts`, … — chúng còn nguyên).
- **Luật:** KHÔNG BAO GIỜ tạo junction/symlink `node_modules` vào worktree tạm; muốn kiểm HEAD thì `git stash`-free: dùng `git archive` + `npm ci` riêng, hoặc chỉ `tsc` với `--baseUrl` trỏ về repo gốc.

## Trạng thái
| Story | Trạng thái | Commit |
|---|---|---|
| KN1 | xong (L0+L1 xanh, L2 [KN:T1] NOT RUN — hubv chưa rebuild) | c888ef6 + 3955b9f |
| KN2 | xong (L0 772/0/0, L1 xanh sau chạy lại — lần đầu 21 đỏ do tranh chấp hubv/Redis rate-limit với phiên VF), probe P-KN1..4 đỏ ✓ | (commit KN2) |
| KN3 | xong trừ KQ1 (U16 mồ côi có lý do, hook `isPayosConfirmProbe` TODO) — L0 786/0/0, L1 KN 14/14 | (commit KN3) |
| KN4 | xong — L1 stripe-connect-db 3/3, probe P-KN4-01 đỏ ✓ | (commit KN4) |

## KN1 — đã làm
- `apps/hub-api/src/modules/service-api/endpoint.service.ts` (lõi chung), `console/endpoints.controller.ts`, 422 `use_endpoints_route` ở `api.controller.ts`.
- Test: `apps/hub-api/test/console-endpoints-db.spec.ts` (U1–U4, L1), `console-endpoints.spec.ts` (U5, L0).
- Web: `destinations/endpoint-dialogs.tsx`, `lib/hub/endpoint-queries.ts`, nút ở `destinations/page.tsx`.
- ADR-142. `verify/lib/map.ts` TAG_RE thêm `KN`.

## KN2 — kế hoạch
- `libs/providers/src/provider.interface.ts`: `ConnectorSpec/ProviderConnector/ConnectorError` (đã viết), `connector-base-url.ts` (đã viết), `test-only-config.ts` luật `*_FAKE_BASE_URL` (đã viết).
- Prisma `SourceConnection` + migration `20261012010000_source_connections` (RLS/FORCE/policy/FK ghép/GRANT) — đã viết, cần `prisma migrate deploy` lên DB hubv (chỉ DDL cộng thêm) trước khi chạy L1.
- Còn: repo methods, `SourceConnectionService` + controller console, redact `credentialsEncrypted`, pino redact, sink fake routes, UI form từ `spec.fields`, test U6–U12, U17, U18.

## KN2/KN3 — đã làm
- KN2: `source-connection.service.ts`, `source-connections.controller.ts`, bảng `source_connections` (migration đã `migrate deploy` lên hubv), fake PayOS/Stripe `tools/verify-sink/fake-providers.js`, UI `sources/connect-dialogs.tsx`. Probe `verify/probes/P-KN1..4.json` (chạy tay bằng scratchpad `probe.js`: 4/4 đỏ).
- KN3: `libs/providers/src/connectors/{http,payos.connector}.ts`, `PayosAdapter.connector`, hook KQ1 `isPayosConfirmProbe`. Test `payos-connector.spec.ts` (U12b, U13), `payos-connect-db.spec.ts` (U8b với fake PayOS + ingest tối thiểu). Docs: ARCHITECTURE §19, CLAUDE.md cạm bẫy 4 + Trạng thái, SPEC-verification §9.1 bước 10. ADR-149.

## Bước tiếp
- (XONG) KN4 Stripe: `libs/providers/src/connectors/stripe.connector.ts` (POST/GET/DELETE `{base}/v1/webhook_endpoints`, form-encoded, `enabled_events[]` = 3 kiểu trong STRIPE_PAYMENT_TYPES), `StripeAdapter.connector`; secret do Stripe sinh -> `result.sourceSecret` (khung KN2 đã lưu version + chồng 24h + gỡ we_ cũ). Test U14, U15 (+ L1 với fake Stripe của sink).
- `KICH-BAN-TEST-DA-SERVICE.md` chặng C (theo route thật) — chưa làm.

## Sửa sau REVIEW-KN (2026-10-11, phiên dev thứ hai) — ADR-151
| Mục | Commit | Ghi chú |
|---|---|---|
| H-1 kết nối source có sẵn + UI chọn "có sẵn / tạo mới" | f23f951 | `POST /api/v1/sources/:id/connect` hoặc `sourceId` trong body `sources/connect`; test L1 `[KN:U19..U21]` (payos-connect-db) |
| L-1 P2002 sourceKey -> 409 | f23f951 | `[KN:U22]`; `POST /api/v1/sources` (dán tay, api.controller) VẪN 500 khi trùng — chưa sửa |
| L-3 chống bấm hai lần | f23f951 | `claimSourceConnection` (UPDATE có điều kiện, PENDING < 60 s -> 409 `connection_in_progress`); `[KN:U23]` |
| M-1 gỡ we_ cũ sau COMMIT | f23f951 | `[KN:U24]` (stripe-connect-db, Proxy làm TX3 lỗi P1001) |
| I-1 + demo/hướng dẫn | 8c5dcbc | DEPLOYMENT §9, HUONG-DAN-DEPLOY §3/§9, SPEC §8.4/§9/§11, HUONG-DAN-TEST-TINH-HUONG 2.0 |
| expectFailure P-KN* + U10 row thật (L-6) | a780a7c | 5/5 probe ✅ qua `npm run verify:probe` (worktree của runner, không junction) |
- Kiểm: L0 `npx jest -w 2` 812/0 (2 suite không nạp = L-5 có từ trước); L1 hub_app: payos-connect-db 7/7, stripe-connect-db 4/4, source-connections-db 7/7; `verify:gates` 0 vi phạm; tsc hub-api + web xanh.
- Còn mở: KQ1/M-2 (chờ production), M-3 L2 T1–T4 (chờ rebuild hubv), L-2, L-4, L-5, L-7, sửa P2002 ở `POST /api/v1/sources`.
