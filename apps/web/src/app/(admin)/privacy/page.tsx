import type { Metadata } from "next";
import Link from "next/link";

// Trang pháp lý TĨNH, công khai (ADR-270): không gate đăng nhập, không gọi hub-api, viết thẳng tiếng Việt —
// nội dung cam kết phải đọc được nguyên văn bởi crawler của Google, không đi qua từ điển i18n.
export const metadata: Metadata = {
  title: "Chính sách quyền riêng tư — Webhook Hub",
  description: "Webhook Hub thu thập, dùng và xoá dữ liệu tài khoản như thế nào khi bạn đăng nhập hoặc đăng ký.",
};

const UPDATED = "2026-10-20";
const CONTACT = "haidepzai2692006@gmail.com";

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-10 text-sm leading-relaxed [&_a]:underline [&_h2]:mt-8 [&_h2]:mb-2 [&_h2]:font-semibold [&_h2]:text-lg [&_li]:mt-1 [&_p]:mt-2 [&_ul]:mt-2 [&_ul]:list-disc [&_ul]:pl-6">
      <h1 className="font-semibold text-2xl">Chính sách quyền riêng tư</h1>
      <p className="text-muted-foreground">Cập nhật lần cuối: {UPDATED}</p>

      <p>
        Webhook Hub là ứng dụng nhận, chuẩn hoá và chuyển tiếp webhook giữa các nền tảng, được xây dựng như một đồ án tốt
        nghiệp. Trang này nói về dữ liệu cá nhân mà ứng dụng xử lý khi bạn đăng ký hoặc đăng nhập.
      </p>

      <h2>1. Dữ liệu chúng tôi nhận</h2>
      <p>
        <strong>Đăng nhập bằng Google.</strong> Ứng dụng chỉ xin các quyền <code>openid email profile</code>. Từ Google, chúng
        tôi nhận: địa chỉ email, trạng thái email đã được Google xác minh hay chưa, tên hiển thị và mã định danh tài khoản
        Google (<code>sub</code>). Chúng tôi <strong>không</strong> đọc Gmail, Google Drive, danh bạ hay bất kỳ dữ liệu nào
        khác của tài khoản Google.
      </p>
      <p>
        <strong>Đăng nhập bằng GitHub.</strong> Ứng dụng xin quyền <code>read:user user:email</code>, nhận mã số tài khoản
        GitHub, tên hiển thị (hoặc tên đăng nhập) và email chính đã xác minh. Mã truy cập của GitHub được dùng xong bỏ, không
        lưu.
      </p>
      <p>
        <strong>Đăng ký bằng email và mật khẩu.</strong> Chúng tôi lưu email, tên và bản băm của mật khẩu (không lưu mật khẩu
        gốc).
      </p>

      <h2>2. Mục đích sử dụng</h2>
      <ul>
        <li>Đăng nhập và nhận diện tài khoản của bạn trong ứng dụng.</li>
        <li>
          Gửi thư hệ thống: xác minh email, đặt lại mật khẩu, thông báo khi tài khoản được liên kết với Google hoặc GitHub.
        </li>
        <li>
          Ghi nhật ký bảo mật (ví dụ đăng nhập thành công, liên kết tài khoản, kèm địa chỉ IP) để phát hiện truy cập bất
          thường.
        </li>
        <li>
          Duy trì phiên đăng nhập bằng cookie cần thiết cho hoạt động của ứng dụng; ngôn ngữ và giao diện bạn chọn được nhớ
          trong cookie/bộ nhớ trình duyệt. Chúng tôi không dùng cookie quảng cáo hay theo dõi.
        </li>
        <li>
          Nếu được bật, ghi lỗi kỹ thuật của trình duyệt và máy chủ qua Sentry; dữ liệu nhạy cảm (email, mã, khoá, mật khẩu)
          được lọc trước khi gửi đi.
        </li>
      </ul>

      <h2>3. Chia sẻ dữ liệu</h2>
      <p>
        Chúng tôi không bán và không chia sẻ dữ liệu cá nhân của bạn cho bên thứ ba vì mục đích thương mại hay quảng cáo.
        Dữ liệu chỉ nằm trên các nhà cung cấp hạ tầng lưu trữ và vận hành mà ứng dụng chạy trên đó (máy chủ, cơ sở dữ liệu,
        dịch vụ gửi thư), và chỉ để vận hành ứng dụng.
      </p>

      <h2>4. Thu hồi quyền và xoá dữ liệu</h2>
      <ul>
        <li>
          Thu hồi quyền truy cập của Webhook Hub vào tài khoản Google tại{" "}
          <a href="https://myaccount.google.com/permissions" rel="noopener noreferrer">
            myaccount.google.com/permissions
          </a>
          .
        </li>
        <li>
          Muốn xoá tài khoản và dữ liệu liên quan, hoặc có câu hỏi về quyền riêng tư, hãy gửi email tới{" "}
          <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
        </li>
      </ul>

      <h2>5. Thay đổi</h2>
      <p>Nếu chính sách thay đổi, ngày cập nhật ở đầu trang sẽ được đổi theo.</p>

      <p className="mt-8">
        <Link href="/login">Về trang đăng nhập</Link>
      </p>
    </main>
  );
}
