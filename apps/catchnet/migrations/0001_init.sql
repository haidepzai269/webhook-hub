-- LH2 (SPEC-hub-sap §4.2 + H6, ADR-214): schema D1 của lưới hứng `hub-hooks`.
-- KHÔNG lưu secret, credentials hay tenant_id. sources_sync chỉ chứa thứ đã công khai trong URL + ack.
-- Áp: `wrangler d1 migrations apply hub-hooks-db --local` (LOCAL). Bản thật: Admin chạy với --remote khi bật Worker.

-- Hàng chờ phát lại. id = x-catchnet-id (ULID sinh ở Worker lúc NHẬN, dùng lại khi phát lại).
CREATE TABLE IF NOT EXISTS inbox (
  id            TEXT PRIMARY KEY,
  source_key    TEXT    NOT NULL,
  provider      TEXT    NOT NULL,
  method        TEXT    NOT NULL,           -- chữ hoa
  target        TEXT    NOT NULL,           -- path + query THÔ đúng như provider gọi (VNPay ký trên query)
  headers_json  TEXT    NOT NULL,           -- header gốc trừ hop-by-hop, cf-*, x-real-ip, x-forwarded-*, x-catchnet-*
  body          BLOB    NOT NULL,           -- bytes nguyên vẹn (HMAC tính trên bytes)
  client_ip     TEXT    NOT NULL,           -- CF-Connecting-IP lúc nhận (cf-* bị lọc khỏi headers_json)
  received_at   INTEGER NOT NULL,           -- ms epoch, giờ Worker nhận
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_at       INTEGER NOT NULL,
  last_status   INTEGER,                    -- HTTP status lần phát lại gần nhất (NULL = lỗi mạng/timeout)
  last_error    TEXT
);
-- Phát lại lấy theo next_at (index range, đọc đúng N dòng — không sort cả bảng, quota rows read của D1 free).
CREATE INDEX IF NOT EXISTS inbox_next ON inbox(next_at);

CREATE TABLE IF NOT EXISTS inbox_dead (
  id            TEXT PRIMARY KEY,
  source_key    TEXT    NOT NULL,
  provider      TEXT    NOT NULL,
  method        TEXT    NOT NULL,
  target        TEXT    NOT NULL,
  headers_json  TEXT    NOT NULL,
  body          BLOB    NOT NULL,
  client_ip     TEXT    NOT NULL,
  received_at   INTEGER NOT NULL,
  attempts      INTEGER NOT NULL,
  last_status   INTEGER,
  last_error    TEXT,
  reason        TEXT    NOT NULL,           -- rejected | refused | not_found | client_error | expired
  dead_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS inbox_dead_at ON inbox_dead(dead_at);

-- Hub đẩy vào qua /_admin/sources/* (§4.5). Không có dòng = Worker không hứng (hub vắng -> 503).
CREATE TABLE IF NOT EXISTS sources_sync (
  source_key    TEXT PRIMARY KEY,
  provider      TEXT    NOT NULL,
  ack_status    INTEGER NOT NULL,           -- 2xx "đã nhận" của adapter (buildAck)
  ack_type      TEXT,                       -- content-type của ack_body
  ack_body      TEXT,                       -- vd {"RspCode":"00","Message":"Confirm Success"}; NULL = không body
  catch_methods TEXT    NOT NULL DEFAULT 'POST', -- H6: GET/HEAD không bao giờ hứng trừ khi source khai GET là sự kiện
  sync_id       TEXT,                       -- lượt resync toàn bộ gần nhất (dọn key không còn)
  updated_at    INTEGER NOT NULL
);

-- Bộ đếm cho trần chống xả rác (§4.2): đếm bằng trigger thay COUNT(*) mỗi lần hứng (COUNT quét cả bảng = đốt rows read).
-- k = '*' (toàn bảng) hoặc source_key.
CREATE TABLE IF NOT EXISTS inbox_count (
  k  TEXT PRIMARY KEY,
  n  INTEGER NOT NULL
);
INSERT OR IGNORE INTO inbox_count (k, n) VALUES ('*', 0);

CREATE TRIGGER IF NOT EXISTS inbox_count_ins AFTER INSERT ON inbox
BEGIN
  INSERT INTO inbox_count (k, n) VALUES (NEW.source_key, 1)
    ON CONFLICT(k) DO UPDATE SET n = n + 1;
  UPDATE inbox_count SET n = n + 1 WHERE k = '*';
END;

CREATE TRIGGER IF NOT EXISTS inbox_count_del AFTER DELETE ON inbox
BEGIN
  UPDATE inbox_count SET n = n - 1 WHERE k = OLD.source_key;
  DELETE FROM inbox_count WHERE k = OLD.source_key AND n <= 0;
  UPDATE inbox_count SET n = n - 1 WHERE k = '*';
END;
