# RESUME — sửa theo REVIEW-AUTH-2026-10-11

Luật: RED→GREEN→GATED→PROBED, mỗi mục một commit có `Verify:`, `npm run verify` exit 0 trước commit. KHÔNG stage SPEC-event-flow-ui.md, DINH-CHINH-2026-10-10.md.

| Mục | Trạng thái | Commit | Ghi chú |
|---|---|---|---|
| R-1 | xong | 275abbd | ADR-109; RED: 18 song song → 18×401 (unit), review: 17×401 |
| R-2 | xong | d237654 | |
| R-7 | xong | c05299f | gate data-migration-rls, ADR-111 | |
| R-3 | xong | e43a60d | ADR-112 | |
| R-4 | xong | (commit R-4) | ADR-119: A +33% -> B +16,8% handle; e2e +1,4% | |
| R-5 | xong | 81f6e2f | ADR-115 | |
| R-6 | chưa | | |
| R-8 | xong | 3dbb7cd | ADR-113 | |
| R-10 | xong | 1eb26a2 | ADR-114 |
| R-12 | xong | 8c61554 | ADR-116 |
| R-13 | xong | e8a6594 | ADR-117 |
| R-14 | xong | 4244c64 | ADR-118 |
| R-11 | xong | baadc21 | script demo |
| R-9 | chưa | | |

## Bước kế
- R-1 PROBED live (hubv, image mới): 18 login sai song song → 5×401 + 13×429.
- R-2: web hubv chạy bằng `--profile web` (cổng 13000). e2e `[AR:R-2] (phần c)` RED trên api cũ (Y bị 429), GREEN sau rebuild.
- Mã test cho review: namespace `AR` (verify/spec-sources.json + TAG_RE trong verify/lib/map.ts), test unit ở apps/hub-api/test/auth-review.spec.ts.
- Smoke hubv: `HUB_URL=http://localhost:14000 PG_CONTAINER=hubv-postgres-1 bash scripts/e2e-smoke.sh` sau khi `set -a; . ./.env.verify` (PG_CONTAINER mặc định là stack DEV).
