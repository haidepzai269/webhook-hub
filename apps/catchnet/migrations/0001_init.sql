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

-- Bộ đếm cho trần chống xả rác (§4.2 + REVIEW-LH2 TB-2/TB-2a): giữ bằng trigger thay COUNT(*)/SUM() mỗi lần hứng (quét cả
-- bảng = đốt rows read). bytes = body + headers_json + target tính theo BYTE (CAST AS BLOB — length(TEXT) đếm ký tự).
-- k:
--   '*'             hàng chờ toàn bảng (n dòng, bytes)
--   '#dead'         inbox_dead toàn bảng — chiếm chung trần dòng + dung lượng
--   <source_key>    hàng chờ + hàng chết CỦA source đó (dòng chết vẫn giữ trần của key tới khi bị dọn sau hạn giữ:
--                   kẻ xấu không "giải phóng" key bằng cách để hub từ chối rồi nạp lại)
--   'day:<n>'       số lần hứng trong ngày UTC thứ n (= received_at / 86400000) — trần quota ghi; không giảm khi xoá
-- source_key chỉ [A-Za-z0-9_-] nên không đụng các khoá có '*', '#', ':'.
-- Mọi cộng/trừ là UPSERT (REVIEW-LH2 N5): dòng đếm bị xoá tay thì tự tạo lại, không âm thầm bỏ qua.
CREATE TABLE IF NOT EXISTS inbox_count (
  k      TEXT PRIMARY KEY,
  n      INTEGER NOT NULL DEFAULT 0,
  bytes  INTEGER NOT NULL DEFAULT 0
);

CREATE TRIGGER IF NOT EXISTS inbox_count_ins AFTER INSERT ON inbox
BEGIN
  INSERT INTO inbox_count (k, n, bytes) VALUES (NEW.source_key, 1, (length(NEW.body) + length(CAST(NEW.headers_json AS BLOB)) + length(CAST(NEW.target AS BLOB))))
    ON CONFLICT(k) DO UPDATE SET n = n + 1, bytes = bytes + excluded.bytes;
  INSERT INTO inbox_count (k, n, bytes) VALUES ('*', 1, (length(NEW.body) + length(CAST(NEW.headers_json AS BLOB)) + length(CAST(NEW.target AS BLOB))))
    ON CONFLICT(k) DO UPDATE SET n = n + 1, bytes = bytes + excluded.bytes;
  INSERT INTO inbox_count (k, n, bytes) VALUES ('day:' || CAST(NEW.received_at / 86400000 AS INTEGER), 1, 0)
    ON CONFLICT(k) DO UPDATE SET n = n + 1;
END;

-- Rời hàng chờ: trừ '*' và key. Dòng sang inbox_dead thì moveDead CHÉP trước rồi mới xoá: trigger dead_ins đã cộng lại
-- cho key, nên dòng chết vẫn chiếm trần của key tới khi purgeDead dọn.
CREATE TRIGGER IF NOT EXISTS inbox_count_del AFTER DELETE ON inbox
BEGIN
  INSERT INTO inbox_count (k, n, bytes) VALUES (OLD.source_key, -1, -(length(OLD.body) + length(CAST(OLD.headers_json AS BLOB)) + length(CAST(OLD.target AS BLOB))))
    ON CONFLICT(k) DO UPDATE SET n = n - 1, bytes = bytes + excluded.bytes;
  INSERT INTO inbox_count (k, n, bytes) VALUES ('*', -1, -(length(OLD.body) + length(CAST(OLD.headers_json AS BLOB)) + length(CAST(OLD.target AS BLOB))))
    ON CONFLICT(k) DO UPDATE SET n = n - 1, bytes = bytes + excluded.bytes;
  DELETE FROM inbox_count WHERE k = OLD.source_key AND n <= 0 AND bytes <= 0;
END;

CREATE TRIGGER IF NOT EXISTS inbox_dead_count_ins AFTER INSERT ON inbox_dead
BEGIN
  INSERT INTO inbox_count (k, n, bytes) VALUES ('#dead', 1, (length(NEW.body) + length(CAST(NEW.headers_json AS BLOB)) + length(CAST(NEW.target AS BLOB))))
    ON CONFLICT(k) DO UPDATE SET n = n + 1, bytes = bytes + excluded.bytes;
  INSERT INTO inbox_count (k, n, bytes) VALUES (NEW.source_key, 1, (length(NEW.body) + length(CAST(NEW.headers_json AS BLOB)) + length(CAST(NEW.target AS BLOB))))
    ON CONFLICT(k) DO UPDATE SET n = n + 1, bytes = bytes + excluded.bytes;
END;

CREATE TRIGGER IF NOT EXISTS inbox_dead_count_del AFTER DELETE ON inbox_dead
BEGIN
  INSERT INTO inbox_count (k, n, bytes) VALUES ('#dead', -1, -(length(OLD.body) + length(CAST(OLD.headers_json AS BLOB)) + length(CAST(OLD.target AS BLOB))))
    ON CONFLICT(k) DO UPDATE SET n = n - 1, bytes = bytes + excluded.bytes;
  INSERT INTO inbox_count (k, n, bytes) VALUES (OLD.source_key, -1, -(length(OLD.body) + length(CAST(OLD.headers_json AS BLOB)) + length(CAST(OLD.target AS BLOB))))
    ON CONFLICT(k) DO UPDATE SET n = n - 1, bytes = bytes + excluded.bytes;
  DELETE FROM inbox_count WHERE k = OLD.source_key AND n <= 0 AND bytes <= 0;
END;
