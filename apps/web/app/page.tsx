'use client';

import React, { useState, useEffect } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  Activity,
  Radio,
  AlertTriangle,
  Send,
  RefreshCw,
  Layers,
  ArrowRight,
  ShieldCheck,
  CheckCircle2,
  Clock,
  ExternalLink,
  ShoppingBag,
  Zap,
} from 'lucide-react';

const API_BASE = 'http://localhost:4000';

export default function DashboardPage() {
  const [activeTab, setActiveTab] = useState<'overview' | 'events' | 'dlq' | 'sources'>('overview');
  const [isConnected, setIsConnected] = useState(false);
  const [overview, setOverview] = useState<any>({
    totalSources: 3,
    totalDestinations: 3,
    totalEvents: 0,
    totalDeliveries: 0,
    deadDeliveries: 0,
    successRate: 100,
  });
  const [events, setEvents] = useState<any[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<any>(null);
  const [dlqDeliveries, setDlqDeliveries] = useState<any[]>([]);
  const [sources, setSources] = useState<any[]>([]);
  const [destinations, setDestinations] = useState<any[]>([]);
  const [healthStatus, setHealthStatus] = useState<any>(null);

  // Giả lập gửi webhook test
  const [testProvider, setTestProvider] = useState('github');
  const [testLoading, setTestLoading] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);

  useEffect(() => {
    // 1. Kết nối Socket.IO
    const socket: Socket = io(API_BASE, {
      transports: ['websocket'],
    });

    socket.on('connect', () => {
      setIsConnected(true);
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
    });

    socket.on('event.received', (newEvent: any) => {
      setEvents((prev) => [newEvent, ...prev.slice(0, 49)]);
      fetchOverview();
    });

    socket.on('delivery.updated', () => {
      fetchOverview();
      fetchDlq();
    });

    fetchOverview();
    fetchEvents();
    fetchDlq();
    fetchSources();
    checkHealth();

    const interval = setInterval(() => {
      fetchOverview();
      checkHealth();
    }, 10000);

    return () => {
      clearInterval(interval);
      socket.disconnect();
    };
  }, []);

  const fetchOverview = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/overview`);
      if (res.ok) setOverview(await res.json());
    } catch {}
  };

  const fetchEvents = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/events?limit=20`);
      if (res.ok) {
        const data = await res.json();
        setEvents(data.events || []);
        if (data.events?.length > 0 && !selectedEvent) {
          setSelectedEvent(data.events[0]);
        }
      }
    } catch {}
  };

  const fetchDlq = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/dlq`);
      if (res.ok) setDlqDeliveries(await res.json());
    } catch {}
  };

  const fetchSources = async () => {
    try {
      const [sRes, dRes] = await Promise.all([
        fetch(`${API_BASE}/api/v1/sources`),
        fetch(`${API_BASE}/api/v1/destinations`),
      ]);
      if (sRes.ok) setSources(await sRes.json());
      if (dRes.ok) setDestinations(await dRes.json());
    } catch {}
  };

  const checkHealth = async () => {
    try {
      const res = await fetch(`${API_BASE}/health`);
      setHealthStatus(await res.json());
    } catch {
      setHealthStatus({ status: 'offline' });
    }
  };

  const replayDelivery = async (deliveryId: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/deliveries/${deliveryId}/replay`, {
        method: 'POST',
      });
      if (res.ok) {
        alert('Đã gửi yêu cầu Replay delivery thành công! (attempt_generation + 1)');
        fetchDlq();
        fetchOverview();
      }
    } catch (e: any) {
      alert('Lỗi replay: ' + e.message);
    }
  };

  const sendTestWebhook = async () => {
    setTestLoading(true);
    setTestResult(null);
    try {
      let url = `${API_BASE}/hooks/github/src_github_main`;
      let headers: any = { 'Content-Type': 'application/json' };
      let body: any = {};

      if (testProvider === 'github') {
        url = `${API_BASE}/hooks/github/src_github_main`;
        headers = {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'push',
          'X-GitHub-Delivery': 'del_' + Date.now(),
          'X-Hub-Signature-256': 'sha256=invalid_mock_or_bypass', // Sẽ được test
        };
        body = {
          ref: 'refs/heads/main',
          repository: { name: 'webhook-hub', full_name: 'admin/webhook-hub' },
          sender: { login: 'tester' },
          head_commit: { id: 'c_' + Date.now(), message: 'feat: Test webhook from Dashboard' },
        };
      } else if (testProvider === 'sepay') {
        url = `${API_BASE}/hooks/sepay/src_sepay_main`;
        headers = {
          'Content-Type': 'application/json',
          'Authorization': 'Apikey sepay_apikey_token_secret_789',
        };
        body = {
          id: Date.now(),
          gateway: 'MBBank',
          transactionDate: new Date().toISOString(),
          accountNumber: '0987654321',
          code: 'DH10001',
          content: 'DH10001 chuyen tien mua cafe',
          transferType: 'in',
          transferAmount: 2000,
        };
      }

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      const resJson = await res.json();
      setTestResult({ status: res.status, data: resJson });
      fetchEvents();
      fetchOverview();
    } catch (e: any) {
      setTestResult({ status: 500, error: e.message });
    } finally {
      setTestLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <header
        style={{
          borderBottom: '1px solid var(--border-subtle)',
          padding: '16px 24px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: 'rgba(11, 15, 25, 0.8)',
          position: 'sticky',
          top: 0,
          zIndex: 10,
          backdropFilter: 'blur(10px)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              background: 'linear-gradient(135deg, #6366f1, #06b6d4)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 800,
              fontSize: 18,
            }}
          >
            W
          </div>
          <div>
            <h1 style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.02em' }}>
              WEBHOOK HUB
            </h1>
            <p style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              Trạm Trung Chuyển Webhook Đa Nền Tảng
            </p>
          </div>
        </div>

        {/* Navigation Tabs */}
        <nav style={{ display: 'flex', gap: '8px' }}>
          <button
            className={activeTab === 'overview' ? 'btn-primary' : 'btn-secondary'}
            onClick={() => setActiveTab('overview')}
          >
            <Activity size={16} /> Tổng Quan
          </button>
          <button
            className={activeTab === 'events' ? 'btn-primary' : 'btn-secondary'}
            onClick={() => setActiveTab('events')}
          >
            <Radio size={16} /> Live Events
          </button>
          <button
            className={activeTab === 'dlq' ? 'btn-primary' : 'btn-secondary'}
            onClick={() => setActiveTab('dlq')}
          >
            <AlertTriangle size={16} /> DLQ ({overview.deadDeliveries})
          </button>
          <button
            className={activeTab === 'sources' ? 'btn-primary' : 'btn-secondary'}
            onClick={() => setActiveTab('sources')}
          >
            <Layers size={16} /> Sources & Dests
          </button>
        </nav>

        {/* Status & Storefront Link */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: 13 }}>
            <span
              className="pulse-dot"
              style={{ background: isConnected ? '#10b981' : '#f43f5e', boxShadow: isConnected ? '0 0 10px #10b981' : '0 0 10px #f43f5e' }}
            />
            <span>{isConnected ? 'Realtime Connected' : 'Disconnected'}</span>
          </div>

          <a
            href="/shop"
            target="_blank"
            className="btn-secondary"
            style={{ textDecoration: 'none', border: '1px solid rgba(16, 185, 129, 0.4)', color: '#34d399' }}
          >
            <ShoppingBag size={16} /> Demo Shop <ExternalLink size={12} />
          </a>
        </div>
      </header>

      {/* Main Content */}
      <main style={{ flex: 1, padding: '24px', maxWidth: 1400, margin: '0 auto', width: '100%' }}>
        {/* --- TAB 1: OVERVIEW --- */}
        {activeTab === 'overview' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            {/* Stat Cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px' }}>
              <div className="glass-card" style={{ padding: '20px' }}>
                <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>TỔNG SỰ KIỆN</p>
                <h2 style={{ fontSize: 32, fontWeight: 700, margin: '8px 0', color: '#38bdf8' }}>
                  {overview.totalEvents}
                </h2>
                <span className="badge badge-info">Ingest At-Least-Once</span>
              </div>

              <div className="glass-card" style={{ padding: '20px' }}>
                <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>TỔNG DELIVERIES</p>
                <h2 style={{ fontSize: 32, fontWeight: 700, margin: '8px 0', color: '#818cf8' }}>
                  {overview.totalDeliveries}
                </h2>
                <span className="badge badge-neutral">Fan-out RabbitMQ</span>
              </div>

              <div className="glass-card" style={{ padding: '20px' }}>
                <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>TỶ LỆ THÀNH CÔNG</p>
                <h2 style={{ fontSize: 32, fontWeight: 700, margin: '8px 0', color: '#34d399' }}>
                  {overview.successRate.toFixed(1)}%
                </h2>
                <span className="badge badge-success">5 Tầng Retry + Jitter</span>
              </div>

              <div className="glass-card" style={{ padding: '20px' }}>
                <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>DEAD LETTER QUEUE</p>
                <h2
                  style={{
                    fontSize: 32,
                    fontWeight: 700,
                    margin: '8px 0',
                    color: overview.deadDeliveries > 0 ? '#fb7185' : 'var(--text-primary)',
                  }}
                >
                  {overview.deadDeliveries}
                </h2>
                <span className={overview.deadDeliveries > 0 ? 'badge badge-danger' : 'badge badge-neutral'}>
                  {overview.deadDeliveries > 0 ? 'Cần Replay' : 'Sạch sẽ'}
                </span>
              </div>
            </div>

            {/* Architecture Flow Banner */}
            <div className="glass-card" style={{ padding: '24px' }}>
              <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: 8 }}>
                <Zap size={18} color="#6366f1" /> Luồng Xử Lý Tin Cậy 2-Hop (Transactional Outbox + Idempotency 5 Chốt)
              </h3>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  background: '#05070d',
                  padding: '20px',
                  borderRadius: '12px',
                  border: '1px solid rgba(255,255,255,0.06)',
                }}
              >
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontWeight: 600, color: '#38bdf8' }}>Providers</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>PayOS · SePay · GitHub</div>
                </div>
                <ArrowRight size={20} color="#64748b" />
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontWeight: 600, color: '#818cf8' }}>1. Ingest API</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Verify + Outbox (Commit)</div>
                </div>
                <ArrowRight size={20} color="#64748b" />
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontWeight: 600, color: '#a78bfa' }}>2. Outbox Relay</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>SKIP LOCKED + Confirms</div>
                </div>
                <ArrowRight size={20} color="#64748b" />
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontWeight: 600, color: '#f472b6' }}>3. Normalize & Route</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>CloudEvents + Deliveries</div>
                </div>
                <ArrowRight size={20} color="#64748b" />
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontWeight: 600, color: '#34d399' }}>4. Deliver Worker</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Circuit + Retry + Senders</div>
                </div>
              </div>
            </div>

            {/* Health & Quick Test */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
              {/* Health Box */}
              <div className="glass-card" style={{ padding: '20px' }}>
                <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <ShieldCheck size={18} color="#34d399" /> Trạng Thái Hệ Thống (/health)
                </h3>
                {healthStatus?.dependencies ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {Object.entries(healthStatus.dependencies).map(([k, v]: [string, any]) => (
                      <div
                        key={k}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '10px 14px',
                          background: 'rgba(255,255,255,0.02)',
                          borderRadius: 8,
                        }}
                      >
                        <span style={{ textTransform: 'capitalize', fontWeight: 500 }}>{k}</span>
                        <span className={v.status === 'up' ? 'badge badge-success' : 'badge badge-danger'}>
                          {v.status === 'up' ? 'Hoạt động' : 'Gặp sự cố'}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p style={{ color: 'var(--text-muted)' }}>Đang kiểm tra kết nối tới các dịch vụ...</p>
                )}
              </div>

              {/* Quick Test Webhook Ingest */}
              <div className="glass-card" style={{ padding: '20px' }}>
                <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Send size={18} color="#06b6d4" /> Bắn Webhook Mẫu Thử Nghiệm
                </h3>
                <div style={{ display: 'flex', gap: '12px', marginBottom: '12px' }}>
                  <select
                    value={testProvider}
                    onChange={(e) => setTestProvider(e.target.value)}
                    style={{
                      background: '#05070d',
                      color: 'white',
                      border: '1px solid var(--border-subtle)',
                      padding: '8px 12px',
                      borderRadius: 8,
                      flex: 1,
                    }}
                  >
                    <option value="sepay">SePay (Bank Transfer - MBBank)</option>
                    <option value="github">GitHub (Repository Push Event)</option>
                  </select>

                  <button className="btn-primary" onClick={sendTestWebhook} disabled={testLoading}>
                    {testLoading ? <RefreshCw size={16} className="animate-spin" /> : <Send size={16} />} Gửi Ngay
                  </button>
                </div>

                {testResult && (
                  <pre className="code-block" style={{ maxHeight: 120 }}>
                    {JSON.stringify(testResult, null, 2)}
                  </pre>
                )}
              </div>
            </div>
          </div>
        )}

        {/* --- TAB 2: LIVE EVENTS --- */}
        {activeTab === 'events' && (
          <div style={{ display: 'grid', gridTemplateColumns: '400px 1fr', gap: '20px', height: 'calc(100vh - 140px)' }}>
            {/* Event List */}
            <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{ padding: '16px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ fontSize: 15, fontWeight: 600 }}>Dòng Sự Kiện ({events.length})</h3>
                <button className="btn-secondary" style={{ padding: '4px 8px', fontSize: 12 }} onClick={fetchEvents}>
                  <RefreshCw size={12} /> Làm mới
                </button>
              </div>

              <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
                {events.map((evt) => (
                  <div
                    key={evt.id}
                    onClick={() => setSelectedEvent(evt)}
                    style={{
                      padding: '12px',
                      borderRadius: 8,
                      marginBottom: 8,
                      cursor: 'pointer',
                      background: selectedEvent?.id === evt.id ? 'rgba(99, 102, 241, 0.15)' : 'rgba(255,255,255,0.02)',
                      border: selectedEvent?.id === evt.id ? '1px solid var(--border-glow)' : '1px solid transparent',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span className="badge badge-info" style={{ fontSize: 10 }}>{evt.source}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {new Date(evt.receivedAt).toLocaleTimeString()}
                      </span>
                    </div>
                    <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{evt.type}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {evt.subject || evt.id}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Event Detail View */}
            <div className="glass-card" style={{ padding: '24px', overflowY: 'auto' }}>
              {selectedEvent ? (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
                    <div>
                      <span className="badge badge-info" style={{ marginBottom: 8 }}>{selectedEvent.source}</span>
                      <h2 style={{ fontSize: 20, fontWeight: 700 }}>{selectedEvent.type}</h2>
                      <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>ID: {selectedEvent.id}</p>
                    </div>
                    <span className="badge badge-success">Đã Chuẩn Hóa</span>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, marginBottom: 20 }}>
                    <div style={{ background: '#05070d', padding: 12, borderRadius: 8 }}>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Correlation ID</div>
                      <div style={{ fontSize: 13, fontFamily: 'monospace' }}>{selectedEvent.correlationId}</div>
                    </div>
                    <div style={{ background: '#05070d', padding: 12, borderRadius: 8 }}>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Thời Gian Tiếp Nhận</div>
                      <div style={{ fontSize: 13 }}>{new Date(selectedEvent.receivedAt).toLocaleString()}</div>
                    </div>
                  </div>

                  <h4 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Dữ Liệu Chuẩn Hóa (Normalized Data)</h4>
                  <pre className="code-block" style={{ marginBottom: 20 }}>
                    {JSON.stringify(selectedEvent.data, null, 2)}
                  </pre>

                  <h4 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
                    Các Lần Phân Phối (Deliveries: {selectedEvent.deliveries?.length || 0})
                  </h4>
                  {selectedEvent.deliveries?.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {selectedEvent.deliveries.map((del: any) => (
                        <div
                          key={del.id}
                          style={{
                            padding: 12,
                            background: '#05070d',
                            borderRadius: 8,
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                          }}
                        >
                          <div>
                            <div style={{ fontWeight: 600, fontSize: 13 }}>
                              {del.subscription?.destination?.name || 'Destination'} ({del.subscription?.destination?.type})
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                              Số lần thử: {del.attemptCount} · Generation: {del.attemptGeneration}
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <span
                              className={
                                del.status === 'SUCCEEDED'
                                  ? 'badge badge-success'
                                  : del.status === 'DEAD'
                                  ? 'badge badge-danger'
                                  : 'badge badge-warning'
                              }
                            >
                              {del.status}
                            </span>
                            <button
                              className="btn-secondary"
                              style={{ padding: '4px 8px', fontSize: 11 }}
                              onClick={() => replayDelivery(del.id)}
                            >
                              Replay
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Chưa có delivery nào được phân phối cho sự kiện này.</p>
                  )}
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' }}>
                  Chọn một sự kiện từ danh sách bên trái để xem chi tiết
                </div>
              )}
            </div>
          </div>
        )}

        {/* --- TAB 3: DEAD LETTER QUEUE (DLQ) --- */}
        {activeTab === 'dlq' && (
          <div className="glass-card" style={{ padding: '24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <div>
                <h2 style={{ fontSize: 18, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <AlertTriangle color="#fb7185" size={20} /> Dead Letter Queue (DLQ)
                </h2>
                <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
                  Các delivery thất bại sau 5 tầng retry hoặc gặp lỗi Non-retryable 4xx được bảo lưu để xử lý thủ công.
                </p>
              </div>
              <button className="btn-secondary" onClick={fetchDlq}>
                <RefreshCw size={14} /> Làm Mới DLQ
              </button>
            </div>

            {dlqDeliveries.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '48px', color: 'var(--text-muted)' }}>
                <CheckCircle2 size={48} color="#10b981" style={{ margin: '0 auto 16px' }} />
                <h3>Không có delivery nào trong Dead Letter Queue!</h3>
                <p style={{ fontSize: 13 }}>Hệ thống đang hoạt động ổn định và tin cậy.</p>
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}>
                    <th style={{ padding: 12 }}>ID</th>
                    <th style={{ padding: 12 }}>ĐÍCH (DESTINATION)</th>
                    <th style={{ padding: 12 }}>SỰ KIỆN</th>
                    <th style={{ padding: 12 }}>LÝ DO LỖI</th>
                    <th style={{ padding: 12 }}>LẦN THỬ</th>
                    <th style={{ padding: 12 }}>THAO TÁC</th>
                  </tr>
                </thead>
                <tbody>
                  {dlqDeliveries.map((del) => (
                    <tr key={del.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                      <td style={{ padding: 12, fontFamily: 'monospace' }}>{del.id.substring(0, 8)}...</td>
                      <td style={{ padding: 12, fontWeight: 600 }}>{del.subscription?.destination?.name}</td>
                      <td style={{ padding: 12 }}>
                        <span className="badge badge-info">{del.event?.type}</span>
                      </td>
                      <td style={{ padding: 12, color: '#fb7185', maxWidth: 300 }}>{del.lastError || 'Lỗi không xác định'}</td>
                      <td style={{ padding: 12 }}>{del.attemptCount}</td>
                      <td style={{ padding: 12 }}>
                        <button className="btn-primary" style={{ padding: '6px 12px', fontSize: 12 }} onClick={() => replayDelivery(del.id)}>
                          <RefreshCw size={12} /> Replay
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* --- TAB 4: SOURCES & DESTINATIONS --- */}
        {activeTab === 'sources' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
            {/* Sources List */}
            <div className="glass-card" style={{ padding: '24px' }}>
              <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Layers size={18} color="#6366f1" /> Nguồn Webhook (Inbound Sources)
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {sources.map((src) => (
                  <div
                    key={src.id}
                    style={{
                      padding: 16,
                      background: '#05070d',
                      borderRadius: 8,
                      border: '1px solid var(--border-subtle)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                      <span style={{ fontWeight: 600 }}>{src.name}</span>
                      <span className="badge badge-success">ACTIVE</span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Provider: {src.provider}</div>
                    <div style={{ background: 'rgba(255,255,255,0.04)', padding: '6px 10px', borderRadius: 4, fontSize: 12, fontFamily: 'monospace', color: '#38bdf8' }}>
                      POST {API_BASE}/hooks/{src.provider}/{src.sourceKey}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Destinations List */}
            <div className="glass-card" style={{ padding: '24px' }}>
              <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Send size={18} color="#34d399" /> Đích Phân Phối (Outbound Destinations)
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {destinations.map((dest) => (
                  <div
                    key={dest.id}
                    style={{
                      padding: 16,
                      background: '#05070d',
                      borderRadius: 8,
                      border: '1px solid var(--border-subtle)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                      <span style={{ fontWeight: 600 }}>{dest.name}</span>
                      <span className="badge badge-info">{dest.type}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-secondary)' }}>
                      <span>Circuit Breaker: <strong style={{ color: '#34d399' }}>{dest.circuitState}</strong></span>
                      <span>Rate Limit: {dest.rateLimitRps ? `${dest.rateLimitRps} rps` : 'Không giới hạn'}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
