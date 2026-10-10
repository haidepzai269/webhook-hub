# RESUME — sửa theo REVIEW-AUTH-2026-10-11

Luật: RED→GREEN→GATED→PROBED, mỗi mục một commit có `Verify:`, `npm run verify` exit 0 trước commit. KHÔNG stage SPEC-event-flow-ui.md, DINH-CHINH-2026-10-10.md.

| Mục | Trạng thái | Commit | Ghi chú |
|---|---|---|---|
| R-1 | xong | 275abbd | ADR-109; RED: 18 song song → 18×401 (unit), review: 17×401 |
| R-2 | xong | d237654 | |
| R-7 | xong | (commit R-7) | gate data-migration-rls, ADR-111 | |
| R-3 | chưa | | |
| R-4 | chưa | | |
| R-5 | chưa | | |
| R-6 | chưa | | |
| R-8 | chưa | | |
| R-9..R-14 | chưa | | |

## Bước kế
- R-1 PROBED live (hubv, image mới): 18 login sai song song → 5×401 + 13×429.
- R-2: web hubv chạy bằng `--profile web` (cổng 13000). e2e `[AR:R-2] (phần c)` RED trên api cũ (Y bị 429), GREEN sau rebuild.
- Mã test cho review: namespace `AR` (verify/spec-sources.json + TAG_RE trong verify/lib/map.ts), test unit ở apps/hub-api/test/auth-review.spec.ts.
