# Danh mục provider (PK9, SPEC-provider-khac §8, ADR-208)

Danh mục là **dữ liệu**. Thêm một provider nghĩa là thêm file JSON và fixture, không sửa lõi.

| Đường dẫn | Nội dung |
|---|---|
| `entries/<id>.json` | Mục đã nạp: fingerprint + handler (`config` / `native` / `unsupported`). Được build. |
| `entries-pending/<id>.json` | Mục chưa nạp được: `blockedBy` (`PK4`, `PK5`, `docs`) và `pendingReason`. **Không** build. |
| `fixtures/<id>/*.http` | Request mẫu của mục (cả mục pending nếu có). |
| `types.ts`, `identify.ts`, `index.ts` | Phía client, thuần, không dùng Node API. Web import qua alias `@hub/providers/catalog`. |
| `catalog.ts` | Phía server: `CATALOG` được kiểm ngay lúc import. Sai thì hub-api không khởi động. |
| `catalog.data.ts` | **Sinh tự động** bởi `npm run catalog:build`. Không sửa tay. |
| `catalog-files.ts`, `tools/` | Đọc đĩa, build, chạy bài A (`npm run verify:catalog`). |

## Luật của một mục trong `entries/`

Các luật dưới đây do `entryProblems` và `readCatalogSources` kiểm.

- `id` khớp `^[a-z0-9-]{2,32}$` và trùng tên file.
- `confidence` là `cao` hoặc `trung bình`. Mục `thấp` để ở `entries-pending/`.
- Fingerprint có ít nhất 1 `required`. User-Agent tính là một mục optional.
- Có đúng một handler:
  - `config`: phải qua `validateGenericConfig`, kể cả các `alternatives`.
  - `native`: phải có trong `ProviderRegistry`.
  - `unsupported`: có `reason`, và `workaround` chỉ đường `POST /v1/p/:project/events`.
- Config dùng sha1 thì phải có `sha1Reason` (ADR-203).
- `sources` khác rỗng. Chi tiết nào nghiên cứu ghi "chưa xác minh" / "kiến thức chung" thì **không** vào mục: hoặc bỏ trống, hoặc chuyển mục sang pending.
- Có ít nhất 1 fixture.

## Quy ước fixture

Một file fixture gồm, theo thứ tự:

```
# origin: official|constructed; source: <url tài liệu chính thức>
POST /path?query HTTP/1.1
Header: value

body
```

- **official**: mẫu chính thức có kèm header, rút gọn nếu dài.
- **constructed**: body lấy từ mẫu chính thức, hoặc dựng từ đúng các trường tài liệu định nghĩa với giá trị giả; header đặt theo tên trong tài liệu.
  - Không có nguồn cho body thì fixture **không có body**, chỉ gồm dòng đầu và tiêu đề. Không bịa trường.
- **Chữ ký, token và secret luôn là chuỗi giả, entropy thấp**, để không thành bí mật và gitleaks không chặn:
  - chữ ký hex: toàn `0`, đúng độ dài;
  - chữ ký base64: `AAAA…=`;
  - token tĩnh: `PLACEHOLDER` hoặc `x`.
  - Không bao giờ lưu chữ ký thật. Bài A chỉ nhận tên nên không cần chữ ký đúng. Bài B (nối được) tự ký lại bằng secret test.
- JWT trong fixture (Wix) dùng tiêu đề rút gọn `{"alg":"x"}` và không có chữ ký, nên không trông giống token thật.

## Lệnh

```bash
npm run catalog:build            # kiểm + sinh catalog.data.ts
npm run verify:catalog           # bài A trên mọi fixture: bảng official / constructed + danh sách pending
npx jest libs/providers/test/catalog-identify.spec.ts --maxWorkers=2   # [PK:T19]–[PK:T23]
```

## Chuyển một mục từ pending sang entries

Cần ba thứ:

1. Scheme cần đã có: PK4 (bắt tay) hoặc PK5 (`unverified`).
2. Mọi chi tiết đã đối chiếu tài liệu (ghi nguồn vào `sources`).
3. Có fixture.

Sau đó chuyển file sang `entries/`, chạy `npm run catalog:build`, và `[PK:T19]` phải xanh. Mục mới mà làm mục khác mất hạng đầu thì test đỏ: sửa fingerprint, hoặc đặt cùng `group` nếu thật sự không tách được.
