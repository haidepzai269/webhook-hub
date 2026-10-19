import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaService } from '@hub/database';
import {
  CommandPeriod,
  QuotaConfig,
  QuotaLevel,
  QuotaNotifyRecord,
  QuotaReading,
  QuotaResourceId,
  UPSTASH_COUNTER_NOTE,
  advanceCommandPeriod,
  decideNotify,
  fastFailRedisOptions,
  formatQuotaMessage,
  logger,
  parseInfoNumber,
  quotaLevelFor,
  quotaPct,
  resolveQuotaConfig,
  scrubTelegramToken,
} from '@hub/common';
import Redis from 'ioredis';
import { hostname } from 'os';
import { randomUUID } from 'crypto';

/**
 * LOG-CAUSE số 7 (ADR-263): worker tự báo Telegram khi Neon/Upstash gần trần gói free (nhà cung cấp free không cảnh báo).
 * Cảnh báo VẬN HÀNH cho Admin, không phải sự kiện tenant: không đi qua subscription/delivery, không bảng DB mới.
 *
 *  - Neon: `pg_database_size` (1 truy vấn nhẹ / nhịp) so với `QUOTA_NEON_STORAGE_BYTES` (mặc định DB_DISK_BUDGET_MB).
 *  - Upstash: MỘT lệnh `INFO` / nhịp -> `total_commands_processed` cộng dồn theo tháng (+ `used_memory` nếu đặt trần).
 *  - Khoá nhịp: `SET NX EX` như storage/cleanup (N worker = MỘT lượt). Chỉ hub-worker chạy job, hub-api không.
 *  - Trạng thái "đã báo mức nào" + bộ cộng dồn lệnh: MỘT key Redis TTL 40 ngày (`quota:alert:state`) — sống qua lần khởi động
 *    lại hằng ngày của Render. Đọc 1 lần / lần khởi động; ghi khi có tin gửi, đổi tháng, hoặc checkpoint 6h.
 *    Redis mất key -> tệ nhất là báo lại một lần và bộ đếm lệnh bắt đầu lại từ lúc đó (đúng BB-2: Redis chỉ làm chậm/dư tin).
 *  - Chi phí Redis: 2 lệnh / nhịp / (N worker -> chỉ 1 qua khoá) = SET NX + INFO (≈ 192/ngày ở 15 phút) + ≤ 5 lệnh/ngày ghi/đọc state.
 *    KHÔNG chạm đường nóng ingest/delivery.
 *  - Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID: job KHÔNG chạy (no-op hoàn toàn, 1 dòng log lúc khởi động).
 */
export const QUOTA_LOCK_KEY = 'quota:alert:lock';
export const QUOTA_STATE_KEY = 'quota:alert:state';
export const QUOTA_STATE_TTL_SECONDS = 40 * 86_400;
export const QUOTA_CHECKPOINT_MS = 6 * 3_600_000;
export const TELEGRAM_TIMEOUT_MS = 5_000;

interface QuotaState {
  v: 1;
  resources: Partial<Record<QuotaResourceId, QuotaNotifyRecord>>;
  upstash?: CommandPeriod;
  persistedAt: number;
}

export interface QuotaTickResult {
  skipped: boolean;
  readings: QuotaReading[];
  sent: { id: QuotaResourceId; kind: string; ok: boolean }[];
}

@Injectable()
export class QuotaAlertJob implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private redis: Redis | null;
  private readonly ownsRedis: boolean;
  private readonly instanceId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private state: QuotaState | null = null;
  private infoWarned = false;
  private stopped = false;
  /** L2: Redis không đọc được state -> dùng state tạm trong bộ nhớ tiến trình (chống spam trong phiên). */
  private degraded = false;
  private lastAnomalyLogAt = 0;
  private readonly token = process.env.TELEGRAM_BOT_TOKEN?.trim() || '';
  private readonly chatId = process.env.TELEGRAM_CHAT_ID?.trim() || '';
  readonly cfg: QuotaConfig = resolveQuotaConfig();

  /** Đồng hồ + fetch (test thay được; test KHÔNG gửi thật). */
  clock: () => number = Date.now;
  fetchImpl: typeof fetch = (url, init) => fetch(url, init);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() redisClient?: Redis,
  ) {
    this.redis = redisClient ?? null;
    this.ownsRedis = !redisClient;
  }

  get enabled(): boolean {
    return this.token !== '' && this.chatId !== '';
  }

  onModuleInit() {
    this.start();
  }

  onModuleDestroy() {
    this.stop();
  }

  start() {
    if (this.running) return;
    if (!this.enabled) {
      logger.info('Quota alert: thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID -> tắt (no-op)');
      return;
    }
    this.running = true;
    this.stopped = false;
    this.schedule(45_000 + Math.floor(Math.random() * 30_000));
    logger.info({ intervalMs: this.cfg.intervalMs, warnPct: this.cfg.warnPct, critPct: this.cfg.critPct, neonStorageBytes: this.cfg.neonStorageBytes, upstashMemoryBytes: this.cfg.upstashMemoryBytes }, 'Quota alert đã khởi động');
  }

  stop() {
    this.running = false;
    this.stopped = true; // L4: sau stop() client() không dựng kết nối mới
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.ownsRedis && this.redis) {
      const r = this.redis;
      this.redis = null;
      r.quit().catch(() => r.disconnect());
    }
  }

  private schedule(ms: number) {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.runOnce()
        .catch((err: any) => logger.warn({ err: scrubTelegramToken(String(err?.message ?? err), this.token) }, 'Quota alert: lượt đo lỗi (bỏ qua)'))
        .finally(() => this.schedule(this.cfg.intervalMs));
    }, ms);
    this.timer.unref?.();
  }

  private client(): Redis {
    if (this.stopped) throw new Error('quota alert đã dừng');
    if (!this.redis) {
      const r = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', fastFailRedisOptions());
      r.on('error', (err) => logger.warn({ err: err.message }, 'Redis (quota alert) lỗi'));
      this.redis = r;
    }
    return this.redis;
  }

  /** 'busy' = instance khác giữ khoá (bỏ lượt). 'error' = Redis lỗi: vẫn chạy bằng state tạm (L2) — chỉ hub-worker chạy job nên không lo gửi đôi. */
  private async acquire(): Promise<'ok' | 'busy' | 'error'> {
    const ttl = Math.max(5, Math.floor((this.cfg.intervalMs * 0.9) / 1000));
    try {
      return (await this.client().set(QUOTA_LOCK_KEY, this.instanceId, 'EX', ttl, 'NX')) === 'OK' ? 'ok' : 'busy';
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'Quota alert: không giành được khoá (Redis lỗi) -> chạy với trạng thái tạm');
      return 'error';
    }
  }

  /** Một lượt có khoá. */
  async runOnce(): Promise<QuotaTickResult> {
    if (!this.enabled || this.stopped) return { skipped: true, readings: [], sent: [] };
    if ((await this.acquire()) === 'busy') return { skipped: true, readings: [], sent: [] };
    return this.tick();
  }

  /** Lõi (không khoá). */
  async tick(): Promise<QuotaTickResult> {
    const now = this.clock();
    const state = await this.loadState();
    let dirty = false;
    const readings: QuotaReading[] = [];
    const notes: Partial<Record<QuotaResourceId, string>> = {};

    const push = (id: QuotaResourceId, used: number, cap: number) => {
      const prev = state.resources[id]?.level ?? 'ok';
      const pct = quotaPct(used, cap);
      readings.push({ id, used, cap, pct, level: quotaLevelFor(pct, prev, this.cfg) });
    };

    try {
      push('neon_storage', await this.prisma.databaseSizeBytes(), this.cfg.neonStorageBytes);
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'Quota alert: không đọc được pg_database_size (bỏ qua Neon lượt này)');
    }

    try {
      const info = await this.client().info();
      const cmds = parseInfoNumber(info, 'total_commands_processed');
      if (cmds === null) {
        if (!this.infoWarned) {
          this.infoWarned = true;
          logger.warn('Quota alert: INFO không có total_commands_processed -> không đo được số lệnh Upstash (Admin kiểm bằng redis-cli INFO)');
        }
      } else {
        const before = state.upstash;
        state.upstash = advanceCommandPeriod(before, cmds, now, this.cfg.upstashMaxCmdPerSec, this.cfg.upstashMaxGapSec);
        if (!before || before.period !== state.upstash.period) dirty = true;
        if ((state.upstash.anomalies ?? 0) > (before?.anomalies ?? 0) && before?.period === state.upstash.period) {
          dirty = true;
          if (now - this.lastAnomalyLogAt >= 3_600_000) {
            this.lastAnomalyLogAt = now;
            logger.warn({ anomalies: state.upstash.anomalies, cmds, last: before?.last }, 'Quota alert: INFO total_commands_processed bất thường (giảm/tăng quá mức hợp lý) -> bỏ mẫu, đặt lại mốc; bộ đếm có thể không đơn điệu/không riêng cho database này');
          }
        }
        push('upstash_commands', state.upstash.acc, this.cfg.upstashCommandsPerMonth);
        notes.upstash_commands = UPSTASH_COUNTER_NOTE + ((state.upstash.anomalies ?? 0) > 0 ? ` Đã bỏ ${state.upstash.anomalies} mẫu INFO bất thường trong tháng.` : '');
      }
      const mem = parseInfoNumber(info, 'used_memory');
      if (this.cfg.upstashMemoryBytes !== null && mem !== null) push('upstash_memory', mem, this.cfg.upstashMemoryBytes);
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'Quota alert: INFO Redis lỗi (bỏ qua Upstash lượt này)');
    }

    const sent: QuotaTickResult['sent'] = [];
    for (const r of readings) {
      const kind = decideNotify(state.resources[r.id], r.level, now, this.cfg.repeatMs);
      if (!kind) continue;
      const ok = await this.sendTelegram(formatQuotaMessage(r, kind, { note: [notes[r.id], this.degraded ? 'Redis không đọc được, đang dùng trạng thái tạm (có thể báo lại sau khi khởi động lại).' : undefined].filter(Boolean).join(' ') || undefined }));
      sent.push({ id: r.id, kind, ok });
      if (ok) {
        state.resources[r.id] = { level: r.level, notifiedAt: now };
        dirty = true;
        logger.warn({ resource: r.id, level: r.level, pct: Math.round(r.pct * 10) / 10, kind }, 'Quota alert: đã báo Telegram');
      }
    }

    // Đang degraded (đọc state lỗi) thì KHÔNG ghi: state tạm không được đè state tốt trong Redis. Đọc lại được -> gộp rồi mới ghi.
    if (!this.degraded && (dirty || now - state.persistedAt >= QUOTA_CHECKPOINT_MS)) await this.saveState(state, now);
    return { skipped: false, readings, sent };
  }

  /**
   * Đọc Redis MỘT lần mỗi lần khởi động. Redis lỗi -> state TẠM trong bộ nhớ (degraded) để vẫn đo Neon và chống spam trong phiên;
   * lượt sau thử đọc lại, đọc được thì nhập (giữ bản ghi báo mới hơn).
   */
  private async loadState(): Promise<QuotaState> {
    if (this.state && !this.degraded) return this.state;
    try {
      const raw = await this.client().get(QUOTA_STATE_KEY);
      let st: QuotaState | null = null;
      if (raw) {
        try {
          const p = JSON.parse(raw);
          if (p && p.v === 1 && typeof p.resources === 'object') st = { v: 1, resources: p.resources ?? {}, upstash: p.upstash, persistedAt: Number(p.persistedAt) || 0 };
        } catch {
          st = null; // key hỏng = như mất key
        }
      }
      st = st ?? { v: 1, resources: {}, persistedAt: 0 };
      if (this.state) {
        for (const [id, rec] of Object.entries(this.state.resources) as [QuotaResourceId, QuotaNotifyRecord][]) {
          if (!st.resources[id] || st.resources[id]!.notifiedAt < rec.notifiedAt) st.resources[id] = rec;
        }
        st.persistedAt = 0; // ghi lại ở cuối lượt này
      }
      this.state = st;
      this.degraded = false;
      return st;
    } catch (err: any) {
      if (!this.degraded) logger.warn({ err: err?.message }, 'Quota alert: không đọc được trạng thái (Redis lỗi) -> dùng trạng thái tạm trong bộ nhớ');
      this.degraded = true;
      this.state = this.state ?? { v: 1, resources: {}, persistedAt: 0 };
      return this.state;
    }
  }

  private async saveState(state: QuotaState, now: number): Promise<void> {
    state.persistedAt = now;
    try {
      await this.client().set(QUOTA_STATE_KEY, JSON.stringify(state), 'EX', QUOTA_STATE_TTL_SECONDS);
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'Quota alert: không ghi được trạng thái (Redis lỗi) -> có thể báo lại sau khi khởi động lại');
    }
  }

  /** Không bao giờ ném; không bao giờ log token (URL chứa token không được ghi). */
  async sendTelegram(text: string): Promise<boolean> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TELEGRAM_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: this.chatId, text }),
        signal: ctrl.signal,
      });
      if (res.ok) return true;
      let desc = '';
      try {
        desc = scrubTelegramToken((await res.text()).slice(0, 200), this.token);
      } catch {
        /* bỏ qua */
      }
      logger.warn({ status: res.status, desc }, 'Quota alert: Telegram trả lỗi (không gửi được)');
      return false;
    } catch (err: any) {
      logger.warn({ err: scrubTelegramToken(String(err?.name === 'AbortError' ? 'timeout' : (err?.message ?? err)), this.token) }, 'Quota alert: gọi Telegram lỗi (không gửi được)');
      return false;
    } finally {
      clearTimeout(t);
    }
  }
}
