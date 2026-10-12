import { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { BloomFilter } from 'bloom-filters';
import type { PrismaService } from '@hub/database';
import { logger, normalizeEmail } from '@hub/common';
import { sha256Hex } from './tokens';
import { onRedisChannel } from '../redis/redis-channels';
import { emailFilterChecks, emailFilterSize } from '../metrics/metrics';

/**
 * ADR-180 — gợi ý "email đã có tài khoản" trên form đăng ký bằng Bloom filter TRONG BỘ NHỚ mỗi instance hub-api.
 *
 * BB-2: filter là đường tắt và được phép sai. `UNIQUE(users.email)` vẫn là trọng tài; `/auth/register` giữ R-6.
 * - Âm tính ("chắc chắn chưa có") -> trả ngay, KHÔNG chạm DB.
 * - Dương tính ("có thể có") -> xác nhận bằng Postgres, nên người dùng không bao giờ thấy "đã dùng" sai.
 * - Chưa dựng xong / đã vượt dung lượng (`degraded`) -> hỏi thẳng DB: đúng nhưng chậm.
 *
 * Bloom thay Cuckoo: `CuckooFilter` của bloom-filters@3.0.4 có âm tính giả khi đẩy chỗ (ADR-180). Bloom không xoá được
 * phần tử — repo không có đường xoá user / đổi email; lượt dựng lại định kỳ chữa nếu sau này có.
 *
 * Khoá trong filter = sha256(normalizeEmail(email)): tin pub/sub qua Upstash chỉ mang hash, không mang email thô.
 * Đồng bộ nhiều instance: sau COMMIT, instance tạo user tự thêm tại chỗ rồi PUBLISH; instance khác nhận tin và thêm.
 * Mất tin -> âm tính giả tạm thời ở instance đó (chỉ mất một gợi ý) cho tới lượt dựng lại định kỳ.
 * Không lệnh Redis nào nằm trên đường nóng ingest/delivery (ngân sách R1 không đổi).
 */
export const EMAIL_FILTER_CHANNEL = 'hub:auth:email-filter';

export interface EmailFilterConfig {
  capacity: number;
  errorRate: number;
  /** 0 = tắt dựng lại định kỳ (test). */
  rebuildMs: number;
  batchSize: number;
}

function int(v: string | undefined, def: number, min: number, max: number): number {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isInteger(n) && n >= min && n <= max ? n : def;
}

export function loadEmailFilterConfig(env: Record<string, string | undefined> = process.env): EmailFilterConfig {
  return {
    capacity: int(env.EMAIL_FILTER_CAPACITY, 100_000, 1_000, 10_000_000),
    errorRate: 0.001,
    rebuildMs: int(env.EMAIL_FILTER_REBUILD_MS, 600_000, 0, 86_400_000),
    batchSize: 1_000,
  };
}

export interface EmailFilterPublisher {
  publish(channel: string, message: string): Promise<unknown>;
}

export type EmailCheckResult = 'negative' | 'positive_confirmed' | 'false_positive' | 'db_fallback';

type Store = Pick<PrismaService, 'identity'>;

interface Built {
  filter: BloomFilter;
  count: number;
}

export class EmailFilterService implements OnApplicationBootstrap, OnModuleDestroy {
  private current: Built | null = null;
  /** Bản đang dựng: email thêm trong lúc dựng đi vào CẢ hai bản, hoán đổi xong không mất. */
  private building: Built | null = null;
  private rebuilding: Promise<void> | null = null;
  private timer?: NodeJS.Timeout;
  private offChannel?: () => void;
  private warnedFull = false;
  private readonly instanceId = randomUUID();

  constructor(
    private readonly store: Store,
    private readonly publisher: EmailFilterPublisher | null,
    private readonly cfg: EmailFilterConfig = loadEmailFilterConfig(),
  ) {}

  /** Đã dựng xong ít nhất một lần. */
  get ready(): boolean {
    return this.current !== null;
  }

  /** Số phần tử vượt dung lượng -> tỉ lệ dương tính giả vượt mục tiêu -> mọi kiểm tra đi DB. */
  get degraded(): boolean {
    return this.current !== null && this.current.count > this.cfg.capacity;
  }

  get size(): number {
    return this.current?.count ?? 0;
  }

  onApplicationBootstrap(): void {
    this.offChannel = onRedisChannel(EMAIL_FILTER_CHANNEL, (m) => this.handleMessage(m));
    // Dựng nền: boot không chờ quét bảng users; trong lúc đó endpoint đi thẳng DB.
    void this.rebuild();
    if (this.cfg.rebuildMs > 0) {
      this.timer = setInterval(() => void this.rebuild(), this.cfg.rebuildMs);
      this.timer.unref?.();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.offChannel?.();
  }

  /**
   * Dựng bản mới từ `hub.users` theo lô keyset `(id)` rồi HOÁN ĐỔI. Lỗi DB -> giữ bản cũ (hoặc vẫn chưa ready), thử lại
   * ở lượt sau. Lượt dựng đang chạy -> trả lại chính promise đó (không dựng chồng).
   */
  rebuild(): Promise<void> {
    if (!this.rebuilding) {
      this.rebuilding = this.doRebuild().finally(() => {
        this.rebuilding = null;
      });
    }
    return this.rebuilding;
  }

  private async doRebuild(): Promise<void> {
    const fresh: Built = { filter: BloomFilter.create(this.cfg.capacity, this.cfg.errorRate), count: 0 };
    this.building = fresh;
    const started = Date.now();
    try {
      const idn = this.store.identity();
      let after: string | null = null;
      for (;;) {
        const rows = await idn.listUserEmailsAfter(after, this.cfg.batchSize);
        for (const r of rows) this.addTo(fresh, keyOf(r.email));
        if (rows.length < this.cfg.batchSize) break;
        after = rows[rows.length - 1].id;
      }
      this.current = fresh;
      this.warnedFull = false;
      this.checkCapacity();
      emailFilterSize.set(fresh.count);
      logger.info({ size: fresh.count, capacity: this.cfg.capacity, ms: Date.now() - started }, 'Bloom filter email: đã dựng lại');
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Bloom filter email: dựng lại lỗi -> giữ bản cũ (BB-2: chỉ chậm đi, không sai)');
    } finally {
      if (this.building === fresh) this.building = null;
    }
  }

  /**
   * GỌI SAU COMMIT tạo user (AuthService.createUserWithFirstProject). Thêm tại chỗ rồi PUBLISH cho instance khác.
   * Không bao giờ ném: lỗi Redis chỉ làm instance khác thiếu gợi ý tới lượt dựng lại.
   */
  recordCreated(email: string): void {
    const key = keyOf(email);
    this.addLocal(key);
    if (!this.publisher) return;
    const msg = JSON.stringify({ op: 'add', h: key, from: this.instanceId });
    void Promise.resolve()
      .then(() => this.publisher!.publish(EMAIL_FILTER_CHANNEL, msg))
      .catch((err) => logger.warn({ err: (err as Error).message }, 'Bloom filter email: PUBLISH lỗi (instance khác chờ lượt dựng lại)'));
  }

  /** Tin pub/sub từ instance khác. Tin của chính mình (đã thêm tại chỗ) và tin sai khuôn bị bỏ. */
  handleMessage(message: string): void {
    let m: { op?: unknown; h?: unknown; from?: unknown };
    try {
      m = JSON.parse(message);
    } catch {
      return;
    }
    if (m?.op !== 'add' || typeof m.h !== 'string' || !/^[0-9a-f]{64}$/.test(m.h)) return;
    if (m.from === this.instanceId) return;
    this.addLocal(m.h);
  }

  /** `available = true` khi email chưa có tài khoản. Email phải đã được kiểm định dạng. */
  async isAvailable(email: string): Promise<{ available: boolean; result: EmailCheckResult }> {
    const normalized = normalizeEmail(email);
    let result: EmailCheckResult;
    let available: boolean;
    if (!this.current || this.degraded) {
      available = !(await this.existsInDb(normalized));
      result = 'db_fallback';
    } else if (!this.current.filter.has(keyOf(normalized))) {
      available = true;
      result = 'negative';
    } else {
      available = !(await this.existsInDb(normalized));
      result = available ? 'false_positive' : 'positive_confirmed';
    }
    emailFilterChecks.inc({ result });
    return { available, result };
  }

  private existsInDb(email: string): Promise<boolean> {
    return this.store
      .identity()
      .findUserByEmail(email)
      .then((u) => !!u);
  }

  private addLocal(key: string): void {
    if (this.current) {
      this.addTo(this.current, key);
      this.checkCapacity();
      emailFilterSize.set(this.current.count);
    }
    if (this.building) this.addTo(this.building, key);
  }

  private addTo(b: Built, key: string): void {
    // Chỉ đếm khi `has` = false: email đến cả từ lượt quét DB lẫn tin pub/sub không bị đếm hai lần. Đổi lại đếm thiếu
    // cỡ tỉ lệ dương tính giả (~0,1%) — ngưỡng `degraded` trễ tương ứng, không đáng kể.
    if (!b.filter.has(key)) {
      b.filter.add(key);
      b.count++;
    }
  }

  private checkCapacity(): void {
    if (this.degraded && !this.warnedFull) {
      this.warnedFull = true;
      logger.warn(
        { size: this.current?.count, capacity: this.cfg.capacity },
        'Bloom filter email vượt EMAIL_FILTER_CAPACITY -> degraded, mọi kiểm tra đi DB (tăng EMAIL_FILTER_CAPACITY)',
      );
    }
  }
}

/** Khoá filter: sha256 của email đã chuẩn hoá — dùng CHUNG normalizeEmail với auth (trim + lowercase). */
export function keyOf(email: string): string {
  return sha256Hex(normalizeEmail(email));
}
