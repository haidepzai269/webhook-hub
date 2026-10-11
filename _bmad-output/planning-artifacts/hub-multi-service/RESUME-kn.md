# RESUME — phiên DEV SPEC-ket-noi (KN1 → KN4)

Spec: `SPEC-ket-noi.md` (ADR-138). Câu hỏi cho Admin: `CAN-ADMIN-QUYET-KN.md`. Lệch spec: §11 của spec.

## Cách chạy nhanh
- L0: `npx jest -w 2 <file>` · L1 một file: đặt env như `verify/cli/run.ts db` (DATABASE_URL hub_app của hubv cổng 15433, VERIFY_DB_OWNER_URL owner, MASTER_KEY của `.env.verify`) rồi `jest --runTestsByPath`. Cả tầng: `npm run verify:db`.
- hubv đang được phiên VF dùng cho chaos (Postgres có lúc bị pause → `PrismaClientInitializationError` tạm thời: chạy lại). KHÔNG restart/rebuild hubv.
- Không commit `verify/baseline.json`, `docs/TEST-MAP.md` (sinh tự động, nhiều phiên cùng sửa).

## Trạng thái
| Story | Trạng thái | Commit |
|---|---|---|
| KN1 | xong (L0+L1 xanh, L2 [KN:T1] NOT RUN — hubv chưa rebuild) | xem `git log --grep KN1` |
| KN2 | đang làm | |
| KN3 | chưa | |
| KN4 | chưa | |

## KN1 — đã làm
- `apps/hub-api/src/modules/service-api/endpoint.service.ts` (lõi chung), `console/endpoints.controller.ts`, 422 `use_endpoints_route` ở `api.controller.ts`.
- Test: `apps/hub-api/test/console-endpoints-db.spec.ts` (U1–U4, L1), `console-endpoints.spec.ts` (U5, L0).
- Web: `destinations/endpoint-dialogs.tsx`, `lib/hub/endpoint-queries.ts`, nút ở `destinations/page.tsx`.
- ADR-142. `verify/lib/map.ts` TAG_RE thêm `KN`.

## KN2 — kế hoạch
- `libs/providers/src/provider.interface.ts`: `ConnectorSpec/ProviderConnector/ConnectorError` (đã viết), `connector-base-url.ts` (đã viết), `test-only-config.ts` luật `*_FAKE_BASE_URL` (đã viết).
- Prisma `SourceConnection` + migration `20261012010000_source_connections` (RLS/FORCE/policy/FK ghép/GRANT) — đã viết, cần `prisma migrate deploy` lên DB hubv (chỉ DDL cộng thêm) trước khi chạy L1.
- Còn: repo methods, `SourceConnectionService` + controller console, redact `credentialsEncrypted`, pino redact, sink fake routes, UI form từ `spec.fields`, test U6–U12, U17, U18.
