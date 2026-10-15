import "@fortawesome/fontawesome-free/css/all.min.css";
// Thanh cuộn dùng chung với admin (một kiểu cho mọi vùng cuộn) — CSS thuần, không kéo Tailwind vào storefront.
import "@/styles/scrollbar.css";
import type { ReactNode } from "react";

import type { Metadata, Viewport } from "next";

// ADR-025: root layout riêng cho storefront — Bootstrap + style.css gốc của Sarab, KHÔNG Tailwind/shadcn.
// ADR-026: icon dùng Font Awesome FREE (npm); không có all.min.css / webfonts Pro của template.
export const metadata: Metadata = {
  title: "Sarab",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function ShopRootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="vi">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700;900&family=Poppins:wght@300;400;500;600;700&family=Dancing+Script:wght@700&display=swap"
        />
        <link rel="stylesheet" href="/shop-assets/css/bootstrap.min.css" />
        <link rel="stylesheet" href="/shop-assets/css/aos.css" />
        <link rel="stylesheet" href="/shop-assets/css/style.css" />
        <link rel="stylesheet" href="/shop-assets/css/shop-cart.css" />
      </head>
      <body>{children}</body>
    </html>
  );
}
