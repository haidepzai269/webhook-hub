import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Webhook Hub — Trạm Trung Chuyển Webhook Đa Nền Tảng',
  description: 'Kết nối dữ liệu tin cậy giữa PayOS, SePay, GitHub và các hệ thống đích',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
