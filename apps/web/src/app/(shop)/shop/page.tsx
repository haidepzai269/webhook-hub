import type { Metadata } from "next";

import { About } from "./_components/About";
import { Blog } from "./_components/Blog";
import { CartDrawer, CartFloat } from "./_components/CartDrawer";
import { Category } from "./_components/Category";
import { CheckoutModal } from "./_components/CheckoutModal";
import { Chefs } from "./_components/Chefs";
import { Contact } from "./_components/Contact";
import { Footer } from "./_components/Footer";
import { Gallery } from "./_components/Gallery";
import { Hero } from "./_components/Hero";
import { History } from "./_components/History";
import { Hours } from "./_components/Hours";
import { Marquee } from "./_components/Marquee";
import { Menu } from "./_components/Menu";
import { MenuPopup } from "./_components/MenuPopup";
import { Navbar } from "./_components/Navbar";
import { Newsletter } from "./_components/Newsletter";
import { Reservation } from "./_components/Reservation";
import { SearchOverlay } from "./_components/SearchOverlay";
import { BackToTop, ShopEffects } from "./_components/ShopEffects";
import { Special } from "./_components/Special";
import { Testimonials } from "./_components/Testimonials";
import { Topbar } from "./_components/Topbar";

export const metadata: Metadata = {
  title: "Sarab — Đồ ăn nhanh & Nhà hàng",
  description: "Đặt burger, pizza, gà rán và thanh toán chuyển khoản QR. Demo cửa hàng nhận webhook qua Webhook Hub.",
};

// Port từ template Sarab (Bestwpware, phân phối bởi ThemeWagon, MIT) — ADR-026.
// Thứ tự section giữ đúng index.html gốc.
export default function ShopPage() {
  return (
    <>
      <ShopEffects />
      <Topbar />
      <Navbar />
      <SearchOverlay />
      <Hero />
      <Marquee />
      <Category />
      <About />
      <Menu />
      <MenuPopup />
      <Special />
      <Gallery />
      <History />
      <Chefs />
      <Hours />
      <Testimonials />
      <Reservation />
      <Blog />
      <Newsletter />
      <Contact />
      <Footer />
      <CartFloat />
      <BackToTop />
      <CartDrawer />
      <CheckoutModal />
    </>
  );
}
