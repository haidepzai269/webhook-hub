import type { Metadata } from "next";

import { SettingsForm } from "./SettingsForm";

export const metadata: Metadata = {
  title: "Cài đặt kết nối — Sarab",
  robots: { index: false, follow: false },
};

// SK3 (SPEC-shop-ket-noi-project §4.4): trang quản trị tạm của Shop — cắm Shop vào project hub của bạn, không đụng Render.
export default function ShopSettingsPage() {
  return <SettingsForm />;
}
