# brand-logos — sinh lại logo thương hiệu của console (ADR-236)

Tạo ra `apps/web/src/components/flow/brand-logos.ts`, nơi `ProviderIcon` và `destinationIcon` lấy logo. **Đừng sửa tay file đó.** Muốn đổi gì thì sửa `brands.mjs` rồi sinh lại.

| File | Việc |
|---|---|
| `brands.mjs` | Danh sách logo: Simple Icons slug hoặc URL SVG chính thức, kèm vùng cắt và màu. **Thường chỉ sửa file này.** |
| `build.mjs` | Tải SVG về, làm sạch trong trình duyệt headless, rồi ghi `brand-logos.ts` |
| `extract.mjs` | Làm sạch SVG: bỏ script, `foreignObject`, `image`, `use`, `a`, `on*`, `href`; chỉ giữ `d`, fill (#hex), fill-rule, transform |
| `generate.mjs` | Dựng nội dung TS (bảng nguồn và giấy phép ở đầu file) |
| `grid.mjs` | Chụp lưới mọi logo trên nền sáng và tối để kiểm bằng mắt |

## Thêm một logo

1. **Có trên Simple Icons.** Tra slug ở https://simpleicons.org, rồi thêm một dòng vào `BRANDS`. `id` là mã provider/đích mà console nhận được (`sources.provider` hoặc id trong catalog):
   ```js
   { id: "gitlab", si: "gitlab" },
   ```
   Title và màu hex lấy từ data của Simple Icons, đúng bản `SIMPLE_ICONS_VERSION`.
   - Nếu Simple Icons chỉ có logo chữ (ví dụ Typeform, WooCommerce) thì đừng thêm, vì ở 13–18px không đọc được.
2. **Không có trên Simple Icons.** Dùng SVG chính thức, lấy từ brand kit, favicon `.svg`, hoặc `mask-icon` của provider:
   ```js
   { id: "payos", title: "PayOS", url: "https://payos.vn/branding/logo.svg",
     region: [0, 0, 230, 999], note: "cắt phần biểu tượng (bỏ chữ payOS)" },
   ```
   - `region: [x0, y0, x1, y1]` (toạ độ viewBox gốc): chỉ giữ phần tử có tâm nằm trong vùng. Dùng để cắt bỏ chữ, giữ lại biểu tượng. Chạy `--only <id>` để xem toạ độ.
   - `exclude: [i]`: bỏ phần tử thứ i, đếm từ 0, không tính `<defs>`. Ví dụ dùng để bỏ nền trắng.
   - `mono: "RRGGBB"`: biến logo thành đơn sắc với màu này. Dùng cho logo gốc toàn màu đen như `mask-icon`.
   - Nếu SVG chỉ nằm inline trong trang HTML: đặt `html: { pattern: "<regex bắt nguyên thẻ <svg>…</svg>>" }` và `url` là trang đó. Xem mục `checkout-com`.
   - Chỉ có PNG/ICO thì **không dùng**. Ghi tên provider vào `NO_LOGO_NOTES`; console sẽ hiện chữ tắt theo tên nguồn.
3. Chạy lệnh ở gốc repo:
   ```sh
   node apps/web/scripts/brand-logos/build.mjs --only <id>   # thử nhanh: in viewBox, số path, màu; không ghi file
   node apps/web/scripts/brand-logos/build.mjs               # tải lại TẤT CẢ và ghi brand-logos.ts
   cd apps/web && npx biome format --write src/components/flow/brand-logos.ts
   node --experimental-strip-types apps/web/scripts/brand-logos/grid.mjs grid.png   # kiểm bằng mắt, đừng commit ảnh
   npx jest apps/web/src/components/flow/brand-logos.spec.ts                        # chạy ở gốc repo
   ```
   - Tuỳ chọn của `build.mjs`:
     - `--date YYYY-MM-DD`: ngày ghi vào bảng nguồn, mặc định là hôm nay.
     - `--out <file>`: ghi ra file khác.
   - Các SVG đã tải được giữ lại trong một thư mục tạm của hệ điều hành; đường dẫn in ở dòng đầu, xem lại được.
4. Xem `git diff` của `brand-logos.ts`. Lần tải lại có thể làm đổi cả các logo cũ, nếu provider đã đổi file trên trang của họ.

## Yêu cầu

- **Node ≥ 22.6.** `grid.mjs` cần `--experimental-strip-types` để đọc thẳng file `.ts`.
- **Mạng ra ngoài, chỉ khi chạy script:** `cdn.jsdelivr.net` (Simple Icons) và domain của từng provider. Console lúc chạy **không bao giờ** tải logo từ ngoài (ADR-236).
- **Playwright:** dùng `@playwright/test` đã có trong `devDependencies` của repo, không cần cài thêm. Trình duyệt được chọn theo thứ tự:
  1. biến `CHROME=<đường dẫn chrome.exe>`;
  2. Chrome hệ thống (`channel: "chrome"`);
  3. Chromium của Playwright. Muốn dùng cái này thì phải tải trước một lần bằng `npx playwright install chromium`.
- **Không thêm dependency npm nào.**

## Giấy phép

- Logo lấy từ Simple Icons dùng giấy phép CC0-1.0.
- Logo chính thức được ghi là `license: "trademark"`: nhãn hiệu thuộc chủ sở hữu, chỉ dùng để nhận diện.
- Nếu một icon trên Simple Icons có giấy phép riêng (trường `license` trong data), `build.mjs` sẽ in cảnh báo. Gặp trường hợp đó phải kiểm lại trước khi dùng.
