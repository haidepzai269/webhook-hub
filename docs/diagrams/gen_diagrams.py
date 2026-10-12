# -*- coding: utf-8 -*-
"""Sinh docs/diagrams/webhook-hub.drawio (8 trang) — vẽ theo CODE THẬT, không theo ý tưởng.

Chạy lại:  python docs/diagrams/gen_diagrams.py
Sửa tay trong draw.io cũng được, nhưng khi đó đừng chạy lại script (sẽ ghi đè).
Bảng màu dùng chung mọi trang: cam = provider · xanh = hub · tím = đích · xám = kho
dữ liệu · xanh lá = thành công · đỏ = lỗi/DLQ · vàng = ghi chú.
"""
from pathlib import Path
from xml.sax.saxutils import quoteattr

KIND = {
    "provider": "fillColor=#ffe6cc;strokeColor=#d79b00;fontColor=#000000;",
    "hub": "fillColor=#dae8fc;strokeColor=#6c8ebf;fontColor=#000000;",
    "dest": "fillColor=#e1d5e7;strokeColor=#9673a6;fontColor=#000000;",
    "store": "fillColor=#f5f5f5;strokeColor=#666666;fontColor=#000000;",
    "ok": "fillColor=#d5e8d4;strokeColor=#82b366;fontColor=#000000;",
    "bad": "fillColor=#f8cecc;strokeColor=#b85450;fontColor=#000000;",
    "note": "fillColor=#fff2cc;strokeColor=#d6b656;fontColor=#000000;",
    "plain": "fillColor=#ffffff;strokeColor=#333333;fontColor=#000000;",
}
EDGE = {
    "n": "strokeColor=#333333;fontColor=#333333;",
    "ok": "strokeColor=#82b366;fontColor=#2d6b2d;strokeWidth=2;",
    "err": "strokeColor=#b85450;fontColor=#b85450;dashed=1;",
    "async": "strokeColor=#6c8ebf;fontColor=#1f4e8c;dashed=1;",
    "bold": "strokeColor=#333333;fontColor=#000000;strokeWidth=2;",
}


class Page:
    def __init__(self, name, w=1700, h=1100):
        self.name, self.w, self.h = name, w, h
        self.cells, self.n = [], 1

    def _id(self):
        self.n += 1
        return f"c{self.n}"

    def _v(self, x, y, w, h, label, style):
        i = self._id()
        self.cells.append(
            f'<mxCell id="{i}" value={quoteattr(label)} style={quoteattr(style)} vertex="1" parent="1">'
            f'<mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/></mxCell>')
        return i

    def box(self, x, y, w, h, label, kind="hub", extra=""):
        return self._v(x, y, w, h, label, f"rounded=1;whiteSpace=wrap;html=1;arcSize=8;{KIND[kind]}{extra}")

    def left(self, x, y, w, h, label, kind="hub", extra=""):
        return self.box(x, y, w, h, label, kind, "align=left;verticalAlign=top;spacingLeft=8;spacingTop=4;" + extra)

    def db(self, x, y, w, h, label, kind="store"):
        return self._v(x, y, w, h, label, f"shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;size=10;{KIND[kind]}")

    def diamond(self, x, y, w, h, label, kind="plain"):
        return self._v(x, y, w, h, label, f"rhombus;whiteSpace=wrap;html=1;{KIND[kind]}")

    def queue(self, x, y, w, h, label, kind="hub"):
        return self._v(x, y, w, h, label, f"shape=process;whiteSpace=wrap;html=1;size=0.08;{KIND[kind]}")

    def exch(self, x, y, w, h, label):
        return self._v(x, y, w, h, label, "shape=hexagon;perimeter=hexagonPerimeter2;whiteSpace=wrap;html=1;size=0.12;"
                       "fillColor=#ffffff;strokeColor=#6c8ebf;strokeWidth=2;fontColor=#000000;")

    def state(self, x, y, w, h, label, kind="hub"):
        return self._v(x, y, w, h, label, f"rounded=1;arcSize=50;whiteSpace=wrap;html=1;fontStyle=1;{KIND[kind]}")

    def actor(self, x, y, label):
        return self._v(x, y, 40, 70, label, "shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;html=1;")

    def group(self, x, y, w, h, label, color="#6c8ebf"):
        return self._v(x, y, w, h, label, f"rounded=1;arcSize=3;whiteSpace=wrap;html=1;dashed=1;fillColor=none;"
                       f"strokeColor={color};verticalAlign=top;align=left;spacingLeft=10;fontStyle=1;fontSize=13;fontColor={color};")

    def text(self, x, y, w, h, label, extra=""):
        return self._v(x, y, w, h, label, "text;html=1;whiteSpace=wrap;align=left;verticalAlign=top;fontColor=#000000;" + extra)

    def title(self, label, sub=""):
        self.text(20, 10, self.w - 40, 60,
                  f'<b style="font-size:20px">{label}</b>' + (f'<br><span style="font-size:12px;color:#555">{sub}</span>' if sub else ""))

    def edge(self, s, t, label="", kind="n", extra="", pts=None):
        """extra: exitX/exitY/entryX/entryY khi cần ép điểm nối; pts: waypoint [(x, y), ...]."""
        i = self._id()
        st = f"edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;endFill=1;labelBackgroundColor=#ffffff;fontSize=11;{EDGE[kind]}{extra}"
        arr = ""
        if pts:
            arr = '<Array as="points">' + "".join(f'<mxPoint x="{x}" y="{y}"/>' for x, y in pts) + "</Array>"
        self.cells.append(
            f'<mxCell id="{i}" value={quoteattr(label)} style={quoteattr(st)} edge="1" parent="1" source="{s}" target="{t}">'
            f'<mxGeometry relative="1" as="geometry">{arr}</mxGeometry></mxCell>')
        return i

    def line(self, x1, y1, x2, y2, label="", kind="n", extra=""):
        i = self._id()
        st = f"html=1;endArrow=block;endFill=1;labelBackgroundColor=#ffffff;fontSize=11;verticalAlign=bottom;{EDGE[kind]}{extra}"
        self.cells.append(
            f'<mxCell id="{i}" value={quoteattr(label)} style={quoteattr(st)} edge="1" parent="1">'
            f'<mxGeometry relative="1" as="geometry"><mxPoint x="{x1}" y="{y1}" as="sourcePoint"/>'
            f'<mxPoint x="{x2}" y="{y2}" as="targetPoint"/></mxGeometry></mxCell>')
        return i

    def legend(self, x, y):
        self.group(x, y, 260, 200, "Chú giải", "#666666")
        items = [("provider", "Provider (nguồn gửi webhook)"), ("hub", "Webhook Hub (code của ta)"),
                 ("dest", "Đích nhận"), ("store", "Kho dữ liệu"), ("ok", "Thành công / đường tắt"),
                 ("bad", "Lỗi · DLQ · DEAD")]
        for k, (kind, lbl) in enumerate(items):
            self.box(x + 12, y + 30 + k * 27, 28, 20, "", kind)
            self.text(x + 48, y + 30 + k * 27, 200, 22, lbl, "fontSize=11;")

    def xml(self):
        body = "".join(self.cells)
        return (f'<mxGraphModel dx="1400" dy="900" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" '
                f'fold="1" page="1" pageScale="1" pageWidth="{self.w}" pageHeight="{self.h}" math="0" shadow="0">'
                f'<root><mxCell id="0"/><mxCell id="1" parent="0"/>{body}</root></mxGraphModel>')


pages = []

# ───────────────────────── 1. Bối cảnh ─────────────────────────
p = Page("1. Bối cảnh hệ thống", 1500, 900)
p.title("1 · Bối cảnh hệ thống (C4 mức 1)",
        "Hub đứng giữa: nhận webhook từ mọi provider, giao lại cho mọi đích. Hub KHÔNG biết 'đơn hàng' là gì (BB-1).")
prov = [p.box(40, 110 + k * 100, 220, 70, l, "provider") for k, l in enumerate([
    "<b>PayOS</b><br>thanh toán QR (VN)", "<b>SePay</b><br>biến động số dư ngân hàng",
    "<b>GitHub</b><br>push · PR · issue", "<b>Stripe</b><br>thanh toán quốc tế"])]
hub = p.box(470, 150, 420, 260,
            "<b style='font-size:18px'>WEBHOOK HUB</b><br><br>① nhận + xác thực chữ ký HMAC<br>② lưu bền (PostgreSQL) rồi mới trả 200<br>"
            "③ chuẩn hoá thành sự kiện chung<br>④ định tuyến theo subscription<br>⑤ giao lại · retry · DLQ · replay<br><br>"
            "<i>Generic: thêm provider = thêm 1 adapter</i>", "hub", "fontSize=13;")
dst = [p.box(1100, 110 + k * 100, 260, 70, l, "dest") for k, l in enumerate([
    "<b>Discord</b><br>kênh thông báo", "<b>Telegram</b><br>bot nhắn tin",
    "<b>Shop demo</b> POST /hub-webhook<br>(nghiệp vụ đơn hàng nằm ở đây)", "<b>Webhook bất kỳ</b><br>URL do khách đăng ký"])]
for k, s in enumerate(prov):
    p.edge(s, hub, "POST /hooks/:provider/:sourceKey<br>body + chữ ký" if k == 0 else "")
for k, d in enumerate(dst):
    p.edge(hub, d, "HTTP POST ký HMAC<br>(webhook-signature)" if k == 2 else "")
adm = p.actor(660, 520, "Admin")
web = p.box(560, 640, 240, 70, "<b>Dashboard</b> (Next.js)<br>xem sự kiện realtime · DLQ · replay", "hub")
p.edge(adm, web, "")
p.edge(web, hub, "REST /api/v1 + Socket.IO", "async")
p.left(40, 560, 440, 170,
       "<b>Vòng demo đầu-cuối</b><br>1. Khách tạo đơn ở Shop → nhận mã <b>DH123</b> + QR<br>2. Khách chuyển khoản qua PayOS<br>"
       "3. PayOS bắn webhook vào <b>Hub</b><br>4. Hub chuẩn hoá → <i>payment.succeeded</i> → giao cho Shop + Discord<br>"
       "5. <b>Shop</b> tự tìm mã DH123 trong sự kiện → đơn PAID<br><i>→ Hub chỉ chở sự kiện, Shop mới hiểu đơn hàng.</i>", "note")
p.legend(1100, 560)
pages.append(p)

# ───────────────────────── 2. Container ─────────────────────────
p = Page("2. Thành phần & tiến trình", 1680, 900)
p.title("2 · Thành phần & tiến trình (C4 mức 2)",
        "hub-api và hub-worker là HAI tiến trình tách rời (BB-4) — scale độc lập: docker compose up --scale hub-worker=3")
# Bố cục 5 cột: provider | hub-api | kho dữ liệu | hub-worker | đích. Hành lang x≈620-670 và x≈890-960 dành cho dây.
prv = p.box(20, 130, 170, 70, "<b>Provider</b><br>PayOS · SePay · GitHub · Stripe", "provider")
p.group(230, 90, 380, 380, "hub-api (NestJS) — chỉ nhận · p95 < 100ms")
ic = p.box(250, 135, 340, 55, "<b>IngestController</b><br>POST /hooks/:provider/:sourceKey (rawBody)")
isv = p.box(250, 215, 340, 55, "<b>IngestService</b><br>verify → TX(raw_events + outbox) → COMMIT → 200")
reg = p.box(250, 295, 340, 55, "<b>ProviderRegistry</b><br>PayOS · SePay · GitHub · Stripe adapter")
api = p.box(250, 385, 160, 55, "<b>/api/v1 · /auth</b><br>REST + JWT")
gw = p.box(430, 385, 160, 55, "<b>RealtimeGateway</b><br>Socket.IO")
p.edge(prv, ic, "webhook", "bold", "exitX=1;exitY=0.5;entryX=0;entryY=0.5;")
p.edge(ic, isv)
p.edge(isv, reg, "adapter.verify()")
pg = p.db(690, 110, 200, 130, "<b>PostgreSQL 16</b><br>schema <b>hub</b> + <b>shop</b><br><i>trọng tài idempotency</i>")
mq = p.db(690, 380, 200, 120, "<b>RabbitMQ 3</b><br>exchanges · queues<br>retry TTL · DLQ")
p.text(690, 510, 260, 110, "<b>Dây nối với hub-worker</b><br>━ đậm: publish <i>event.received</i>, <i>deliver</i><br>─ mảnh: consume <i>q.normalize</i>, <i>q.delivery.main</i><br>PostgreSQL ← relay đọc outbox · normalize ghi events/deliveries", "fontSize=11;")
rd = p.db(690, 640, 200, 120, "<b>Redis 7</b><br>idem · rate limit<br>circuit · pub/sub<br><i>được phép sai</i>")
p.edge(isv, pg, "TX", "bold", "exitX=1;exitY=0.3;entryX=0;entryY=0.6;")
p.edge(isv, rd, "GET/SET idem<br>rate limit", "async", "exitX=1;exitY=0.8;entryX=0;entryY=0.35;", [(650, 259), (650, 682)])
p.edge(rd, gw, "SUBSCRIBE", "async", "exitX=0;exitY=0.7;entryX=0.5;entryY=1;", [(630, 724), (630, 490), (510, 490)])
p.group(960, 90, 380, 420, "hub-worker (NestJS) — xử lý · chạy N bản")
rel = p.box(980, 135, 340, 55, "<b>OutboxRelay</b><br>poll ~500ms · FOR UPDATE SKIP LOCKED")
nc = p.box(980, 215, 340, 55, "<b>NormalizeConsumer</b><br>q.normalize → events + deliveries")
dc = p.box(980, 295, 340, 55, "<b>DeliveryConsumer</b><br>q.delivery.main → gửi · retry · DLQ")
cb = p.box(980, 375, 160, 55, "<b>CircuitBreaker</b><br>+ Throttle")
snd = p.box(1160, 375, 160, 55, "<b>SenderRegistry</b><br>webhook · discord · telegram")
p.text(980, 445, 340, 60, "<i>Không có hub-scheduler riêng (ADR-020). Tắt máy: ngừng consume → chờ in-flight ≤ 25s.</i>", "fontSize=11;")
p.edge(dc, cb, "", "n", "exitX=0.25;exitY=1;entryX=0.5;entryY=0;")
p.edge(dc, snd, "", "n", "exitX=0.75;exitY=1;entryX=0.5;entryY=0;")
p.edge(rel, pg, "", "n", "exitX=0;exitY=0.4;entryX=1;entryY=0.33;")
p.edge(nc, pg, "", "n", "exitX=0;exitY=0.4;entryX=1;entryY=0.9;")
p.edge(rel, mq, "", "bold", "exitX=0;exitY=0.85;entryX=1;entryY=0.2;", [(905, 182), (905, 404)])
p.edge(nc, mq, "", "bold", "exitX=0;exitY=0.85;entryX=1;entryY=0.4;", [(918, 262), (918, 428)])
p.edge(mq, nc, "", "n", "exitX=1;exitY=0.65;entryX=0;entryY=0.1;", [(935, 458), (935, 220)])
p.edge(mq, dc, "", "n", "exitX=1;exitY=0.85;entryX=0;entryY=0.2;", [(948, 482), (948, 306)])
p.edge(cb, rd, "circuit · throttle<br>PUBLISH realtime", "async", "exitX=0.5;exitY=1;entryX=1;entryY=0.5;", [(1060, 700)])
ds = p.box(1420, 360, 230, 90, "<b>Đích</b><br>Discord · Telegram<br>Shop /hub-webhook<br>URL bất kỳ", "dest")
p.edge(snd, ds, "HTTP 5s · HMAC<br>SSRF guard", "bold", "exitX=1;exitY=0.5;entryX=0;entryY=0.7;")
sh = p.box(1420, 130, 230, 80, "<b>apps/shop</b> (~300 dòng)<br>đơn hàng · đối soát", "dest")
p.edge(sh, pg, "chỉ đọc/ghi schema shop", "n", "exitX=0.5;exitY=0;entryX=0.5;entryY=0;", [(1535, 75), (790, 75)])
wb = p.box(380, 560, 240, 70, "<b>apps/web</b> (Next.js)<br>Dashboard", "hub")
p.edge(gw, wb, "Socket.IO", "async", "exitX=0.25;exitY=1;entryX=0.55;entryY=0;")
p.edge(wb, api, "REST", "async", "exitX=0;exitY=0.5;entryX=0.5;entryY=1;")
p.box(1420, 520, 230, 60, "<b>Prometheus + Grafana</b><br>/metrics · p95 · queue depth", "store")
p.legend(1100, 620)
pages.append(p)

# ───────────────────────── 3. Ingest sequence ─────────────────────────
p = Page("3. Ingest — thứ tự bắt buộc", 1750, 1250)
p.title("3 · Ingest — thứ tự BẮT BUỘC (apps/hub-api/.../ingest.service.ts)",
        "Không bao giờ trả 2xx trước khi COMMIT (BB-3). Redis SET nằm SAU COMMIT. PostgreSQL là trọng tài duy nhất (BB-2).")
L = {"prov": 110, "api": 400, "redis": 690, "pg": 980}
for key, (lbl, kind) in {"prov": ("Provider<br>(PayOS…)", "provider"), "api": ("hub-api<br>IngestService", "hub"),
                         "redis": ("Redis<br><i>đường tắt</i>", "store"), "pg": ("PostgreSQL<br><i>trọng tài</i>", "store")}.items():
    x = L[key]
    p.box(x - 90, 80, 180, 50, f"<b>{lbl}</b>", kind)
    p.line(x, 130, x, 1200, "", "n", "endArrow=none;dashed=1;strokeColor=#999999;")
y = 165


def msg(a, b, label, kind="n", dy=52):
    global y
    p.line(L[a], y, L[b], y, label, kind)
    y += dy


def self_note(a, label, kind="note", h=40, w=250):
    global y
    p.box(L[a] + 8, y - 12, w, h, label, kind, "fontSize=11;")
    y += h + 14


msg("prov", "api", "<b>POST /hooks/payos/{sourceKey}</b> — giữ nguyên raw bytes")
self_note("api", "<b>①</b> body &gt; 1MB → <b>413</b>, dừng")
msg("api", "pg", "<b>②</b> nạp source + secrets (404 nếu không có/tắt/lưu trữ)")
msg("api", "redis", "<b>③</b> rate limit theo source (100/phút)")
msg("redis", "api", "OK · hoặc 429 · Redis chết → fail-open", "async")
self_note("api", "<b>④</b> giải mã secrets (AES-GCM) · adapter.verify(<b>body_raw</b>, headers, secrets[])<br>so sánh bằng crypto.timingSafeEqual", h=48, w=270)
self_note("api", "<b>⑤</b> key = adapter.extractIdempotencyKey()<br>vd. payos:{orderCode}:{reference}", h=48, w=270)
msg("api", "redis", "<b>⑥</b> GET idem:{sourceId}:{key} — <i>chỉ ĐỌC</i>")
msg("redis", "api", "hit → trả <b>200 duplicate</b> ngay, không chạm DB", "ok", 60)
tx_top = y - 22
msg("api", "pg", "<b>⑦</b> BEGIN")
msg("api", "pg", "INSERT raw_events  — <b>UNIQUE(source_id, idempotency_key)</b>")
msg("api", "pg", "INSERT outbox (topic = event.received, payload = {rawEventId…})")
msg("api", "pg", "<b>COMMIT</b>", "bold")
msg("pg", "api", "OK — sự kiện đã nằm trên đĩa", "ok", 40)
p.group(L["api"] - 40, tx_top, L["pg"] - L["api"] + 80, y - tx_top, "", "#6c8ebf")
p.text(L["pg"] + 50, tx_top + 4, 230, 60, "<b>Transaction</b><br>raw_events + outbox<br>cùng sống / cùng chết", "fontSize=11;fontColor=#1f4e8c;")
y += 10
p.line(60, y, 1050, y, "", "n", "endArrow=none;strokeColor=#b85450;strokeWidth=3;")
p.text(70, y - 26, 600, 24, "<b style='color:#b85450'>━━ BB-3: chỉ từ dòng này trở xuống mới được trả 2xx ━━</b>")
y += 40
msg("api", "redis", "<b>⑧</b> SET idem:{sourceId}:{key} EX 86400 — <i>SAU COMMIT, lỗi thì mặc kệ</i>")
msg("api", "prov", "<b>⑨ 200</b> — adapter.buildAck() đúng định dạng provider mong đợi", "ok")
# nhánh lỗi
p.left(1100, 330, 300, 70, "<b>Sai chữ ký (bước ④)</b><br>INSERT raw_events(status=REJECTED) để điều tra<br>→ <b>401</b>, dừng", "bad")
p.left(1100, 560, 300, 110, "<b>Lỗi trong transaction (bước ⑦)</b><br>• P2002 unique violation → <b>trùng thật</b> → 200 duplicate<br>"
       "• lỗi khác (PG chết…) → ROLLBACK → <b>500</b><br>→ provider tự retry, không mất gì", "bad")
p.left(1100, 700, 300, 100, "<b>Vì sao Redis SET ở SAU COMMIT?</b><br>Nếu SET trước mà PG chết, key vẫn còn → lần retry của provider bị trả "
       "'200 duplicate' → sự kiện mất vĩnh viễn.", "note")
# SAI vs ĐÚNG
p.group(1430, 90, 300, 560, "❌ Bản ý tưởng gốc — SAI", "#b85450")
p.left(1445, 125, 270, 380,
       "1. SET idem NX ở Redis → <b>OK</b><br>2. BEGIN<br>3. INSERT raw_events…<br>4. 💥 PostgreSQL chết → ROLLBACK<br>"
       "5. Trả 500, provider sẽ retry<br>6. Provider retry cùng sự kiện<br>7. Redis: key ĐÃ CÓ → <b>200 duplicate</b><br>"
       "8. Provider: <i>'giao xong rồi'</i>, ngừng retry<br><br><b style='color:#b85450'>→ SỰ KIỆN MẤT VĨNH VIỄN.<br>Không log lỗi nào. Không ai biết.</b>", "bad")
p.left(1445, 520, 270, 115,
       "<b>✅ Bản đúng (đang chạy)</b><br>Redis chỉ ĐỌC trước TX, chỉ GHI sau COMMIT.<br>Redis mất dữ liệu → hệ thống <b>chậm đi, không sai</b>.", "ok")
pages.append(p)

# ───────────────────────── 4. Pipeline ─────────────────────────
p = Page("4. Luồng xử lý 2 hop", 1740, 1000)
p.title("4 · Luồng xử lý đầu-cuối: Ingest → Outbox → Normalize → Deliver",
        "Tách 'nhận' khỏi 'xử lý'. 2 hop qua RabbitMQ. at-least-once + consumer idempotent = effectively-once.")
p.group(20, 80, 300, 560, "hub-api · INGEST")
a1 = p.box(40, 120, 260, 55, "<b>Provider</b> gửi webhook", "provider")
a2 = p.box(40, 210, 260, 80, "verify chữ ký → <b>TX</b>(raw_events + outbox)<br>→ COMMIT → <b>200</b><br><i>(chi tiết: trang 3)</i>")
a3 = p.db(70, 330, 200, 100, "<b>hub.outbox</b><br>published_at = NULL")
p.edge(a1, a2)
p.edge(a2, a3, "ghi cùng TX", "bold")
p.group(350, 80, 320, 560, "hub-worker · OUTBOX RELAY")
r1 = p.box(370, 120, 280, 45, "tick mỗi ~500ms (± jitter)")
r2 = p.box(370, 195, 280, 85, "<b>BEGIN</b><br>SELECT … WHERE published_at IS NULL<br>LIMIT 50 <b>FOR UPDATE SKIP LOCKED</b>")
r3 = p.box(370, 310, 280, 70, "publish → <b>x.hub.events</b><br>key event.received<br>(chờ publisher confirm)")
r4 = p.box(370, 410, 280, 55, "UPDATE published_at = now()<br><b>COMMIT</b>")
p.left(370, 490, 280, 130, "<b>Vì sao an toàn?</b><br>• N worker cùng poll: SKIP LOCKED → mỗi row đúng 1 worker lấy<br>"
       "• publish lỗi → ROLLBACK → lần sau gửi lại (at-least-once)<br>• chấp nhận trùng, phía sau đã chặn trùng", "note", "fontSize=11;")
p.edge(r1, r2)
p.edge(r2, r3)
p.edge(r3, r4)
p.edge(a3, r2, "đọc", "n", "exitX=1;exitY=0.5;entryX=0;entryY=0.5;", [(335, 380), (335, 237)])
p.group(700, 80, 420, 640, "hub-worker · HOP 1 · NORMALIZE + ROUTE")
n1 = p.box(720, 120, 240, 55, "consume <b>q.normalize</b><br>{rawEventId, tenantId}")
n2 = p.diamond(730, 200, 220, 90, "processed_messages<br>đã có (normalize, id)?")
n2y = p.box(980, 220, 120, 50, "ack, bỏ qua<br><i>(chốt ⑤)</i>", "ok")
n3 = p.box(720, 320, 240, 55, "adapter.normalize(raw)<br>→ 1..n <b>NormalizedEvent</b>")
n4 = p.left(720, 400, 240, 125, "<b>TRANSACTION</b><br>• INSERT events (UNIQUE key)<br>• tìm subscriptions khớp type<br>"
            "• INSERT deliveries (1 / subscription)<br>• INSERT processed_messages")
n5 = p.box(720, 550, 240, 55, "publish → <b>x.hub.delivery</b><br>key deliver (mỗi delivery 1 msg)")
n6 = p.box(720, 635, 240, 40, "<b>ack</b>", "ok")
n_err = p.box(980, 320, 125, 110, "lỗi vĩnh viễn<br>nack(requeue=false)<br>→ <b>q.normalize.dlq</b>", "bad", "fontSize=11;")
p.edge(n1, n2)
p.edge(n2, n2y, "có", "ok")
p.edge(n2, n3, "chưa")
p.edge(n3, n4)
p.edge(n4, n5)
p.edge(n5, n6)
p.edge(n3, n_err, "", "err", "exitX=1;exitY=0.5;entryX=0;entryY=0.25;")
p.edge(r3, n1, "RabbitMQ", "bold", "exitX=1;exitY=0.5;entryX=0;entryY=0.5;", [(685, 345), (685, 147)])
p.group(1150, 80, 570, 900, "hub-worker · HOP 2 · DELIVER")
d1 = p.box(1170, 120, 250, 50, "consume <b>q.delivery.main</b>")
d2 = p.diamond(1180, 195, 230, 80, "Circuit của đích<br>đang OPEN?")
d2y = p.box(1440, 205, 220, 60, "đích đã hỏng → đẩy tầng retry<br><b>DÀI NHẤT (2h)</b>, ack", "bad", "fontSize=11;")
d3 = p.diamond(1180, 300, 230, 80, "Throttle của đích<br>hết token?")
d3y = p.box(1440, 310, 220, 60, "đẩy <b>retry.10s</b>, ack<br><i>đích chưa hỏng, chỉ giữ nhịp</i>", "note", "fontSize=11;")
d4 = p.box(1170, 405, 250, 85, "status = DELIVERING<br>render template<br>HTTP · timeout tổng 5s mặc định (DELIVERY_TIMEOUT_MS 1–10s) · không follow redirect<br>SSRF guard")
d5 = p.diamond(1180, 515, 230, 90, "Kết quả HTTP?<br><i>(ghi delivery_attempts)</i>")
d_ok = p.box(1165, 660, 165, 95, "<b>2xx</b><br>→ SUCCEEDED<br>reset circuit · ack<br>pub/sub → dashboard", "ok", "fontSize=11;")
d_4 = p.box(1345, 660, 165, 95, "<b>4xx</b> (trừ 408, 429)<br>lỗi cấu hình<br>→ <b>DEAD</b> ngay → DLQ", "bad", "fontSize=11;")
d_r = p.box(1525, 660, 170, 95, "<b>5xx · 408 · 429<br>timeout</b><br>→ <b>RETRYING</b><br>10s·1m·5m·30m·2h", "note", "fontSize=11;")
d_dead = p.box(1525, 810, 170, 60, "hết 5 tầng<br>→ <b>DEAD</b> → DLQ", "bad", "fontSize=11;")
d_rep = p.box(1165, 805, 300, 70, "Dashboard: <b>Replay</b><br>attempt_generation + 1 → bản ghi MỚI<br>(trang 6)", "hub", "fontSize=11;")
p.edge(d1, d2)
p.edge(d2, d2y, "có", "err")
p.edge(d2, d3, "không")
p.edge(d3, d3y, "có")
p.edge(d3, d4, "không")
p.edge(d4, d5)
B = "exitX=0.5;exitY=1;entryX=0.5;entryY=0;"
p.edge(d5, d_ok, "2xx", "ok", B)
p.edge(d5, d_4, "4xx", "err", B)
p.edge(d5, d_r, "tạm thời", "n", B)
p.edge(d_r, d_dead, "quá tầng", "err", B)
p.edge(d_dead, d_rep, "thủ công", "async", "exitX=0;exitY=0.5;entryX=1;entryY=0.5;")
p.edge(d_r, d1, "hết TTL → quay lại q.delivery.main", "async", "exitX=1;exitY=0.3;entryX=1;entryY=0.5;", [(1705, 688), (1705, 145)])
p.edge(n5, d1, "RabbitMQ", "bold", "exitX=1;exitY=0.5;entryX=0;entryY=0.5;", [(1135, 577), (1135, 145)])
p.legend(20, 700)
pages.append(p)

# ───────────────────────── 5. RabbitMQ ─────────────────────────
p = Page("5. Topology RabbitMQ", 1600, 1000)
p.title("5 · Topology RabbitMQ (libs/messaging/src/topology.ts — khai báo ở MỘT chỗ duy nhất)",
        "Retry KHÔNG dùng requeue (vòng lặp nóng) mà dùng queue có TTL + dead-letter quay về exchange chính.")
o = p.box(20, 130, 180, 60, "<b>OutboxRelay</b><br>(hub-worker)")
ex1 = p.exch(260, 125, 190, 70, "<b>x.hub.events</b><br>topic")
q1 = p.queue(540, 130, 200, 60, "<b>q.normalize</b><br>DLX = x.hub.normalize.dlx")
nc = p.box(830, 130, 190, 60, "<b>NormalizeConsumer</b>")
p.edge(o, ex1, "publish")
p.edge(ex1, q1, "event.received")
p.edge(q1, nc, "consume")
ex2 = p.exch(540, 250, 200, 60, "<b>x.hub.normalize.dlx</b><br>direct")
q2 = p.queue(830, 250, 190, 60, "<b>q.normalize.dlq</b>", "bad")
p.edge(q1, ex2, "nack(requeue=false)", "err")
p.edge(ex2, q2, "dead", "err")
ex3 = p.exch(260, 440, 190, 70, "<b>x.hub.delivery</b><br>direct")
q3 = p.queue(540, 445, 200, 60, "<b>q.delivery.main</b>")
dc = p.box(830, 445, 190, 60, "<b>DeliveryConsumer</b>")
p.edge(nc, ex3, "publish deliver", "bold", "exitX=1;exitY=0.5;entryX=0.5;entryY=0;", [(1050, 160), (1050, 365), (355, 365)])
p.edge(ex3, q3, "deliver")
p.edge(q3, dc, "consume")
p.group(1100, 370, 300, 420, "5 tầng retry (messageTtl)")
tiers = [("q.delivery.retry.10s", "TTL 10s · lần 1"), ("q.delivery.retry.1m", "TTL 1 phút · lần 2"),
         ("q.delivery.retry.5m", "TTL 5 phút · lần 3"), ("q.delivery.retry.30m", "TTL 30 phút · lần 4"),
         ("q.delivery.retry.2h", "TTL 2 giờ · lần 5")]
tq = [p.queue(1120, 405 + k * 75, 260, 55, f"<b>{a}</b><br>{b}", "note") for k, (a, b) in enumerate(tiers)]
p.edge(dc, tq[0], "sendToQueue<br>(theo attempt)", "async")
p.text(380, 520, 330, 40, "<span style='color:#1f4e8c'>↑ hết TTL → DLX = x.hub.delivery, key deliver<br>(tự quay lại q.delivery.main)</span>", "fontSize=11;")
p.edge(tq[4], ex3, "", "async",
       "exitX=0;exitY=0.5;entryX=0.5;entryY=1;", [(1070, 732), (1070, 545), (355, 545)])
ex4 = p.exch(830, 590, 190, 60, "<b>x.hub.delivery.dlx</b><br>direct")
q4 = p.queue(830, 700, 190, 55, "<b>q.delivery.dlq</b>", "bad")
p.edge(dc, ex4, "DEAD (4xx / hết tầng)", "err", "exitX=0.5;exitY=1;entryX=0.5;entryY=0;")
p.edge(ex4, q4, "dead", "err", "exitX=0.5;exitY=1;entryX=0.5;entryY=0;")
p.left(20, 640, 440, 230,
       "<b>Quy tắc</b><br>• Mọi exchange/queue <b>durable</b>, khai báo idempotent khi app khởi động<br>"
       "• RETRY_TIERS tự assert sắp <b>tăng dần</b> theo TTL lúc load module<br>"
       "• Circuit OPEN → nhảy thẳng tầng <b>dài nhất</b> (tìm theo TTL lớn nhất, không theo vị trí mảng)<br>"
       "• Throttle hết token → tầng <b>ngắn nhất</b> (10s)<br>"
       "• ⚠️ Đổi TTL của queue đã tồn tại → <b>PRECONDITION_FAILED</b>: xoá queue trước", "note", "fontSize=11;")
p.left(490, 790, 530, 90,
       "<b>Từ DLQ đi đâu?</b> Dashboard → POST /api/v1/deliveries/:id/replay → tạo delivery mới với "
       "<b>attempt_generation + 1</b>, publish lại vào x.hub.delivery. Lịch sử cũ giữ nguyên, ghi audit_logs.", "hub", "fontSize=11;")
pages.append(p)

# ───────────────────────── 6. State machines ─────────────────────────
p = Page("6. Máy trạng thái", 1600, 1000)
p.title("6 · Máy trạng thái: Delivery · Circuit breaker · Order (Shop)",
        "Chuyển trạng thái không hợp lệ bị từ chối ở tầng service.")
p.group(20, 80, 760, 520, "Delivery (hub.deliveries.status)")
s_p = p.state(50, 140, 150, 55, "PENDING")
s_d = p.state(320, 140, 150, 55, "DELIVERING")
s_s = p.state(600, 140, 150, 55, "SUCCEEDED", "ok")
s_r = p.state(320, 330, 150, 55, "RETRYING<br><span style='font-weight:normal;font-size:10px'>hết TTL → về DELIVERING</span>", "note")
s_x = p.state(600, 330, 150, 55, "DEAD", "bad")
p.edge(s_p, s_d, "consumer nhận")
p.edge(s_d, s_s, "2xx", "ok")
p.edge(s_d, s_r, "5xx · 408 · 429<br>timeout", "n", "exitX=0.25;exitY=1;entryX=0.25;entryY=0;")
p.edge(s_r, s_d, "", "async", "exitX=0.6;exitY=0;entryX=0.6;entryY=1;")
p.edge(s_d, s_x, "4xx (≠408/429)", "err", "exitX=0.9;exitY=1;entryX=0.5;entryY=0;", [(455, 265), (675, 265)])
p.edge(s_r, s_x, "quá tầng 5", "err")
p.edge(s_x, s_p, "REPLAY: attempt_generation + 1<br>→ bản ghi MỚI · audit_logs", "async",
       "exitX=0.5;exitY=1;entryX=0.5;entryY=1;")
p.text(40, 480, 720, 100, "<b>Vì sao replay không đụng UNIQUE?</b> Ràng buộc là <b>UNIQUE(event_id, subscription_id, attempt_generation)</b> — "
       "bản gốc dùng (event_id, subscription_id) thì replay = vi phạm unique = chết. Mỗi lần replay là một generation mới; "
       "lịch sử các lần trước còn nguyên trong delivery_attempts.", "fontSize=12;")
p.group(820, 80, 760, 520, "Circuit breaker — theo từng destination, lưu ở Redis")
c_c = p.state(860, 150, 150, 55, "CLOSED", "ok")
c_o = p.state(1360, 150, 150, 55, "OPEN", "bad")
c_h = p.state(1110, 350, 150, 55, "HALF_OPEN", "note")
p.edge(c_c, c_o, "≥ 5 lỗi liên tiếp<br>SET :state OPEN EX 60 · bắn alert")
p.edge(c_o, c_h, "60s trôi qua<br>(:state hết hạn)", "n", "exitX=0.25;exitY=1;entryX=1;entryY=0.3;", [(1397, 366)])
p.edge(c_h, c_c, "gửi thành công<br>DEL :failures", "ok")
p.edge(c_h, c_o, "thất bại → mở lại ngay", "err", "exitX=1;exitY=0.75;entryX=0.75;entryY=1;", [(1472, 391)])
p.left(840, 440, 720, 140,
       "<b>⚠️ Đối chiếu code (circuit-breaker.service.ts):</b> HALF_OPEN không được lưu riêng — khi key <b>:state</b> hết hạn, getState() trả "
       "CLOSED; bộ đếm <b>:failures</b> vẫn ≥ 5 nên chỉ cần 1 lỗi là OPEN lại. Khác doc §5.4: trong cửa sổ đó <b>mọi</b> message đều được gửi, "
       "không phải đúng 1 request thử.<br><b>Redis chết →</b> fail-open (coi như CLOSED) + log cảnh báo.", "note", "fontSize=11;")
p.group(20, 640, 760, 320, "Order — thuộc apps/shop, Hub KHÔNG biết (BB-1)", "#9673a6")
o_p = p.state(50, 730, 140, 50, "PENDING", "dest")
o_paid = p.state(560, 730, 140, 50, "PAID", "ok")
o_u = p.state(300, 665, 150, 50, "UNDERPAID", "note")
o_e = p.state(300, 830, 150, 50, "EXPIRED", "bad")
o_c = p.state(560, 830, 140, 50, "CANCELLED", "bad")
p.edge(o_p, o_paid, "đủ tiền", "ok", "exitX=1;exitY=0.5;entryX=0;entryY=0.5;")
p.edge(o_p, o_u, "thiếu tiền", "n", "exitX=0.5;exitY=0;entryX=0;entryY=0.5;")
p.edge(o_u, o_paid, "trả bù", "ok", "exitX=1;exitY=0.5;entryX=0.5;entryY=0;")
p.edge(o_p, o_e, "quá hạn", "err", "exitX=0.4;exitY=1;entryX=0;entryY=0.5;")
p.edge(o_p, o_c, "huỷ", "err", "exitX=0.75;exitY=1;entryX=0.5;entryY=1;", [(155, 930), (630, 930)])
p.left(820, 640, 760, 160,
       "<b>Cặp khái niệm trình bày cùng nhau (ADR-016)</b><br>"
       "• <b>Throttle</b> = <i>phòng ngừa</i>: giữ nhịp để không làm đích quá tải (token bucket theo destination.rate_limit_rps)<br>"
       "• <b>Circuit breaker</b> = <i>phản ứng</i>: đích ĐÃ hỏng thì ngừng đập vào nó<br>"
       "Thiếu throttle: scale worker lên 5 sẽ bắn gấp 5 lần vào một đích yếu → tự tạo ra sự cố mà circuit breaker phải đi dọn.",
       "hub", "fontSize=12;")
pages.append(p)

# ───────────────────────── 7. ERD ─────────────────────────
p = Page("7. Mô hình dữ liệu (schema hub)", 1650, 1050)
p.title("7 · Mô hình dữ liệu — schema hub (libs/database/prisma/schema.prisma)",
        "Xanh = bảng nghiệp vụ mang tenant_id, chỉ truy cập qua TenantScopedRepository (BB-5). Xám = bảng hạ tầng.")


def tbl(x, y, h, name, rows, kind="hub", w=270):
    return p.left(x, y, w, h, f"<b style='font-size:13px'>{name}</b><hr>" + "<br>".join(rows), kind, "fontSize=11;")


t_src = tbl(30, 90, 170, "sources", ["id uuid PK", "<b>tenant_id</b>", "provider (payos|sepay|github|stripe)", "name",
                                     "🔑 source_key UNIQUE (nằm trong URL)", "is_active"])
t_sec = tbl(30, 320, 150, "source_secrets", ["id uuid PK", "source_id FK", "secret_encrypted (AES-GCM)", "version",
                                             "valid_from · valid_until", "<i>nhiều secret = xoay khoá không gián đoạn</i>"], "store")
t_raw = tbl(350, 90, 250, "raw_events", ["id uuid PK", "source_id FK", "idempotency_key", "headers jsonb · body jsonb",
                                         "<b>body_raw bytea</b> ← HMAC tính trên đây", "signature_valid",
                                         "status ACCEPTED|REJECTED|DUPLICATE", "origin", "received_at",
                                         "🔑 <b>② UNIQUE(source_id, idempotency_key)</b>"], "store")
t_out = tbl(350, 400, 140, "outbox", ["id bigserial PK", "topic = event.received", "payload {rawEventId, tenantId…}",
                                      "published_at (NULL = chưa gửi)", "attempts"], "store")
t_pm = tbl(350, 600, 100, "processed_messages", ["consumer", "message_id", "🔑 <b>⑤ PK(consumer, message_id)</b>"], "store")
t_evt = tbl(680, 90, 270, "events  (chuẩn hoá, kiểu CloudEvents)", ["id ULID PK", "<b>tenant_id</b>",
                                                                   "raw_event_id FK <i>NULL nếu phái sinh</i>", "parent_event_id",
                                                                   "🔑 <b>③ idempotency_key UNIQUE</b>", "correlation_id",
                                                                   "type (vd. payment.succeeded)", "source · subject", "data jsonb",
                                                                   "origin webhook|replay|derived|reconciliation"], w=290)
t_del = tbl(1030, 90, 270, "deliveries", ["id uuid PK", "<b>tenant_id</b>", "event_id FK", "subscription_id FK",
                                          "<b>attempt_generation</b>", "status PENDING…DEAD", "attempt_count · next_attempt_at",
                                          "last_error",
                                          "🔑 <b>④ UNIQUE(event_id, subscription_id,<br>attempt_generation)</b>"])
t_att = tbl(1030, 420, 180, "delivery_attempts", ["id bigserial PK", "delivery_id FK", "attempt_no", "request_body",
                                                  "response_status · response_body (≤2KB)", "duration_ms · error"], "store")
t_sub = tbl(1360, 90, 170, "subscriptions", ["id uuid PK", "<b>tenant_id</b>", "destination_id FK",
                                             "event_types text[]", "template", "is_active"])
t_dst = tbl(1360, 330, 210, "destinations", ["id uuid PK", "<b>tenant_id</b>", "type webhook|telegram|discord",
                                             "config_encrypted", "signing_secret_encrypted", "rate_limit_rps (throttle)",
                                             "circuit_state", "alert_on_open"])
t_aud = tbl(1360, 600, 150, "audit_logs", ["id bigserial PK", "<b>tenant_id</b>", "action (vd. REPLAY)",
                                           "entity_type · entity_id", "actor · reason", "metadata"])
p.edge(t_sec, t_src, "N : 1")
p.edge(t_raw, t_src, "N : 1")
p.edge(t_evt, t_raw, "0..1 : 1")
p.edge(t_del, t_evt, "N : 1")
p.edge(t_del, t_sub, "N : 1")
p.edge(t_att, t_del, "N : 1")
p.edge(t_sub, t_dst, "N : 1")
p.edge(t_out, t_raw, "payload.rawEventId<br>(không FK)", "async")
p.left(30, 760, 900, 210,
       "<b>5 chốt idempotency (§5.2)</b><br>"
       "① <b>Redis</b> idem:{src}:{key} EX 86400 — đường tắt, <i>được phép sai</i><br>"
       "② <b>raw_events</b> UNIQUE(source_id, idempotency_key) — <b>trọng tài</b> (BB-2): provider gửi trùng<br>"
       "③ <b>events</b> UNIQUE(idempotency_key) — chặn sự kiện phái sinh trùng (key = sha256(parentEventId:type))<br>"
       "④ <b>deliveries</b> UNIQUE(event_id, subscription_id, attempt_generation) — chặn fan-out trùng, <b>vẫn cho replay</b><br>"
       "⑤ <b>processed_messages</b> PK(consumer, message_id) — consumer nhận lại message không gây tác dụng phụ<br>"
       "<b>→ at-least-once + idempotent consumer = effectively-once</b>", "note", "fontSize=12;")
p.left(960, 800, 560, 100,
       "<b>Schema shop</b> (orders: order_code UNIQUE, amount, paid_amount, status, version — optimistic lock) "
       "nằm cùng database nhưng <b>Hub không bao giờ đọc</b>. Shop chỉ nhận sự kiện qua HTTP như mọi đích khác.",
       "dest", "fontSize=11;")
pages.append(p)

# ───────────────────────── 8. Chaos ─────────────────────────
p = Page("8. Gãy rồi tự lành", 1700, 950)
p.title("8 · Gãy rồi tự lành — kịch bản demo chaos (chạy trên LOCAL docker-compose, ADR-019)",
        "Mỗi cột: sự cố → hệ thống phản ứng → kết quả quan sát được. Không cột nào kết thúc bằng 'mất sự kiện'.")
scen = [
    ("💥 PostgreSQL chết<br>giữa lúc ingest",
     "Transaction lỗi → ROLLBACK → trả <b>500</b><br>Redis <b>chưa</b> SET (SET nằm sau COMMIT)",
     "Provider tự retry → PG sống lại → lần sau ghi được.<br><b>Không mất · không nhầm duplicate</b>",
     "docker compose stop postgres<br>bắn webhook → 500<br>docker compose start postgres"),
    ("💥 Redis chết",
     "Rate limit fail-open · GET idem trả null<br>circuit breaker coi như CLOSED<br>→ mọi request đi thẳng xuống PG",
     "<b>Chậm đi, không sai.</b><br>Gửi trùng vẫn bị UNIQUE ② ở PG chặn",
     "docker compose stop redis<br>bắn cùng 1 webhook 2 lần<br>→ lần 2 vẫn 200 duplicate"),
    ("💥 RabbitMQ chết",
     "Ingest vẫn <b>200</b> (chỉ ghi PG)<br>Relay publish lỗi → ROLLBACK<br>outbox giữ published_at = NULL",
     "Rabbit lên lại → relay đẩy bù toàn bộ.<br><b>Nhận vẫn chạy khi xử lý chết</b> — lý do tách 2 hop",
     "docker compose stop rabbitmq<br>bắn 10 webhook → đều 200<br>start lại → 10 sự kiện chảy tiếp"),
    ("💥 Worker bị kill<br>giữa chừng",
     "Message chưa ack → RabbitMQ trả về queue<br>worker khác nhận lại<br>processed_messages ⑤ chặn xử lý 2 lần",
     "Không mất, không gửi trùng.<br>Tắt êm: SIGTERM → chờ in-flight ≤ <b>25s</b>",
     "docker compose up --scale hub-worker=3<br>docker kill &lt;1 worker&gt;<br>xem dashboard vẫn chạy"),
    ("💥 Đích (Discord) chết",
     "5xx → retry 10s → 1m → 5m…<br>≥ 5 lỗi → circuit <b>OPEN</b> 60s + alert<br>message nhảy tầng retry dài nhất",
     "Hết 5 tầng → <b>DEAD</b> → DLQ<br>Đích sống lại → <b>Replay</b> từ dashboard (generation + 1)",
     "cho /mock/discord trả 500<br>xem delivery RETRYING → DEAD<br>sửa lại → bấm Replay → SUCCEEDED"),
]
for k, (inc, react, res, demo) in enumerate(scen):
    x = 20 + k * 335
    a = p.box(x, 100, 315, 80, f"<b style='font-size:14px'>{inc}</b>", "bad")
    b = p.box(x, 230, 315, 120, react, "hub", "fontSize=12;")
    c = p.box(x, 400, 315, 110, res, "ok", "fontSize=12;")
    d = p.left(x, 560, 315, 100, "<b>Cách demo</b><br><span style='font-family:monospace;font-size:11px'>" + demo + "</span>", "store")
    p.edge(a, b, "hệ thống phản ứng", "err")
    p.edge(b, c, "kết quả", "ok")
p.left(20, 710, 1660, 90,
       "<b>Thông điệp cho hội đồng:</b> độ tin cậy không đến từ việc <i>không có gì hỏng</i>, mà từ việc <b>mỗi thành phần hỏng đều có chỗ để rơi vào</b>: "
       "PostgreSQL giữ sự thật, outbox giữ thứ chưa gửi, RabbitMQ giữ thứ chưa xử lý xong, DLQ giữ thứ không gửi được, replay đưa nó về. "
       "Redis là thứ duy nhất được phép mất — và mất nó chỉ làm hệ thống chậm đi.", "note", "fontSize=13;")
pages.append(p)

# ───────────────────────── xuất file ─────────────────────────
out = Path(__file__).with_name("webhook-hub.drawio")
diagrams = "".join(f'<diagram id="p{k + 1}" name={quoteattr(pg_.name)}>{pg_.xml()}</diagram>' for k, pg_ in enumerate(pages))
out.write_text(f'<mxfile host="drawio" type="device">{diagrams}</mxfile>', encoding="utf-8")
print(f"OK {out} — {len(pages)} trang")
