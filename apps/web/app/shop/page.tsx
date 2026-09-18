'use client';

import React, { useState, useEffect } from 'react';
import { ShoppingBag, ArrowLeft, CheckCircle, QrCode, CreditCard, Sparkles, RefreshCw, Zap } from 'lucide-react';

const SHOP_API = 'http://localhost:4001';
const HUB_API = 'http://localhost:4000';

export default function DemoShopPage() {
  const [products, setProducts] = useState<any[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<any>(null);
  const [currentOrder, setCurrentOrder] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [isSimulating, setIsSimulating] = useState(false);

  useEffect(() => {
    fetchProducts();
  }, []);

  // Polling trạng thái đơn hàng mỗi 2s khi đang chờ thanh toán
  useEffect(() => {
    if (!currentOrder || currentOrder.status === 'PAID') return;

    const timer = setInterval(async () => {
      try {
        const res = await fetch(`${SHOP_API}/orders/${currentOrder.orderCode}`);
        if (res.ok) {
          const updated = await res.json();
          if (updated.status !== currentOrder.status) {
            setCurrentOrder(updated);
          }
        }
      } catch {}
    }, 2000);

    return () => clearInterval(timer);
  }, [currentOrder]);

  const fetchProducts = async () => {
    try {
      const res = await fetch(`${SHOP_API}/products`);
      if (res.ok) setProducts(await res.json());
    } catch {}
  };

  const createOrder = async (product: any) => {
    setLoading(true);
    try {
      const res = await fetch(`${SHOP_API}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: product.price,
          paymentProvider: 'sepay',
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setCurrentOrder(data.order);
        setSelectedProduct(product);
      }
    } catch (e: any) {
      alert('Lỗi tạo đơn: ' + e.message);
    } finally {
      setLoading(false);
    }
  };

  // Nút mô phỏng bắn webhook SePay vào Hub để kích hoạt luồng thanh toán thật
  const simulatePaymentWebhook = async () => {
    if (!currentOrder) return;
    setIsSimulating(true);

    try {
      const res = await fetch(`${HUB_API}/hooks/sepay/src_sepay_main`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Apikey sepay_apikey_token_secret_789',
        },
        body: JSON.stringify({
          id: Date.now(),
          gateway: 'MBBank',
          transactionDate: new Date().toISOString(),
          accountNumber: '0987654321',
          code: currentOrder.orderCode,
          content: `${currentOrder.orderCode} thanh toan don hang`,
          transferType: 'in',
          transferAmount: currentOrder.amount,
          description: `Chuyen khoan don ${currentOrder.orderCode}`,
        }),
      });

      if (res.ok) {
        // Đợi 1 nhịp để worker xử lý và gửi webhook về shop
      }
    } catch (e: any) {
      alert('Lỗi bắn webhook: ' + e.message);
    } finally {
      setIsSimulating(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', background: '#070a13', color: '#f8fafc', padding: '32px 20px' }}>
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        {/* Header Shop */}
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 32 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 10,
                background: 'linear-gradient(135deg, #10b981, #06b6d4)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <ShoppingBag size={22} color="#fff" />
            </div>
            <div>
              <h1 style={{ fontSize: 20, fontWeight: 700 }}>DEMO SHOP MÔ PHỎNG</h1>
              <p style={{ fontSize: 13, color: '#94a3b8' }}>Khách hàng nhận Outbound Webhook từ Webhook Hub</p>
            </div>
          </div>

          <a
            href="/"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              color: '#94a3b8',
              textDecoration: 'none',
              fontSize: 13,
            }}
          >
            <ArrowLeft size={16} /> Quay lại Dashboard
          </a>
        </header>

        {/* Nội dung mua hàng */}
        {!currentOrder ? (
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}>Chọn sản phẩm để thanh toán thử nghiệm:</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
              {products.map((p) => (
                <div
                  key={p.id}
                  className="glass-card"
                  style={{
                    padding: 24,
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                  }}
                >
                  <div>
                    <h3 style={{ fontSize: 17, fontWeight: 700, marginBottom: 8 }}>{p.name}</h3>
                    <p style={{ color: '#94a3b8', fontSize: 13, marginBottom: 16 }}>{p.description}</p>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 20, fontWeight: 800, color: '#34d399' }}>
                      {p.price.toLocaleString('vi-VN')} đ
                    </span>
                    <button
                      className="btn-primary"
                      onClick={() => createOrder(p)}
                      disabled={loading}
                    >
                      <CreditCard size={16} /> Đặt Hàng Ngay
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="glass-card" style={{ padding: 32 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
              <div>
                <span className="badge badge-info" style={{ marginBottom: 6 }}>
                  MÃ ĐƠN: {currentOrder.orderCode}
                </span>
                <h2 style={{ fontSize: 22, fontWeight: 800 }}>{selectedProduct?.name}</h2>
              </div>

              <div>
                {currentOrder.status === 'PAID' ? (
                  <span className="badge badge-success" style={{ padding: '8px 16px', fontSize: 13 }}>
                    <CheckCircle size={16} style={{ marginRight: 6 }} /> ĐÃ THANH TOÁN
                  </span>
                ) : (
                  <span className="badge badge-warning" style={{ padding: '8px 16px', fontSize: 13 }}>
                    <RefreshCw size={14} className="animate-spin" style={{ marginRight: 6 }} /> CHỜ THANH TOÁN
                  </span>
                )}
              </div>
            </div>

            {/* Chi tiết thanh toán QR */}
            {currentOrder.status !== 'PAID' ? (
              <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 24, alignItems: 'center' }}>
                <div style={{ background: '#fff', padding: 12, borderRadius: 12, display: 'inline-block' }}>
                  <img
                    src={currentOrder.qrCodeUrl}
                    alt="QR Payment"
                    style={{ width: '100%', height: 'auto', display: 'block' }}
                  />
                </div>

                <div>
                  <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Hướng dẫn thanh toán mô phỏng:</h3>
                  <p style={{ fontSize: 14, color: '#94a3b8', lineHeight: 1.6, marginBottom: 16 }}>
                    Quét mã QR hoặc chuyển khoản với nội dung chứa mã đơn{' '}
                    <strong style={{ color: '#38bdf8' }}>{currentOrder.orderCode}</strong>, số tiền{' '}
                    <strong style={{ color: '#34d399' }}>{currentOrder.amount?.toLocaleString()} đ</strong>.
                  </p>

                  <div style={{ padding: 16, background: 'rgba(99, 102, 241, 0.08)', borderRadius: 8, border: '1px solid var(--border-glow)', marginBottom: 20 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#818cf8', fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
                      <Sparkles size={16} /> Kiểm thử tính năng tự động chuyển trạng thái:
                    </div>
                    <p style={{ fontSize: 12, color: '#cbd5e1', marginBottom: 12 }}>
                      Bấm nút dưới đây để giả lập SePay bắn webhook báo có tiền vào Webhook Hub. Hub sẽ xử lý, ký HMAC và chuyển tiếp tới Demo Shop!
                    </p>
                    <button
                      className="btn-primary"
                      onClick={simulatePaymentWebhook}
                      disabled={isSimulating}
                    >
                      <Zap size={16} /> {isSimulating ? 'Đang bắn webhook...' : 'Mô Phỏng Webhook Thanh Toán (SePay)'}
                    </button>
                  </div>

                  <button className="btn-secondary" onClick={() => setCurrentOrder(null)}>
                    Hủy & Chọn sản phẩm khác
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: '32px 0' }}>
                <CheckCircle size={64} color="#10b981" style={{ margin: '0 auto 16px' }} />
                <h2 style={{ fontSize: 24, fontWeight: 800, color: '#34d399', marginBottom: 8 }}>
                  Thanh Toán Thành Công!
                </h2>
                <p style={{ color: '#94a3b8', fontSize: 14, marginBottom: 24 }}>
                  Webhook Hub đã chuyển phát thông báo thanh toán có chữ ký HMAC Standard Webhooks đến Demo Shop. Đơn hàng đã được ghi nhận hoàn tất!
                </p>
                <button className="btn-primary" onClick={() => setCurrentOrder(null)}>
                  Tiếp Tục Mua Hàng
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
