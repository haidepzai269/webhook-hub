-- LH-S spike: một bảng duy nhất, vứt đi được. KHÔNG phải schema LH2 (§4.2).
CREATE TABLE IF NOT EXISTS hits (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT    NOT NULL,          -- 'hook' | 'cron_tick'
  received_at     INTEGER NOT NULL,          -- ms epoch, giờ Worker
  method          TEXT,
  url             TEXT,                      -- URL đầy đủ, có query
  headers_json    TEXT,                      -- toàn bộ header như Worker thấy
  body_len        INTEGER,
  body_sha256     TEXT,                      -- hex, tính trên bytes nhận được
  body            BLOB,                      -- NULL nếu > 1MB
  body_too_large  INTEGER NOT NULL DEFAULT 0,
  note            TEXT                       -- cron: kết quả fan-out S6
);
CREATE INDEX IF NOT EXISTS hits_kind ON hits(kind, id);
