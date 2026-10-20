# ADR-270 — Trang /privacy công khai để publish Google OAuth In production (2026-10-20)

**Vấn đề:** Consent screen đang Testing nên chỉ 4 test user đăng nhập Google được; nút Publish đòi Branding có Application home page + privacy policy link nằm trên authorized domain `webhook-hub-rouge.vercel.app`, mà repo chưa có trang chính sách.

**Chọn:** Thêm trang `/privacy` công khai, render phía server, không phụ thuộc đăng nhập (server component, tiếng Việt viết thẳng, không gọi hub-api, không qua AuthGuard) ở `apps/web/src/app/(admin)/privacy`, nội dung bám đúng code (scope `openid email profile`, GitHub `read:user user:email`); link ở footer các trang auth. Không tải logo lên consent screen để tránh brand verification.

**Đánh đổi:** Vẫn dùng chung Google Cloud project với client `gmail.send` (chung consent screen/trạng thái publish) — có thể tách project sau; trang pháp lý không qua i18n nên chưa có bản tiếng Anh; home page `/` hiện redirect sang `/dashboard` (rồi `/login`).
