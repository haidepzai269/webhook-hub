import { Inject, Injectable, Optional } from '@nestjs/common';
import { PrismaService, getMasterKey } from '@hub/database';
import { RedisService } from '../redis/redis.service';
import { ProviderRegistry } from '@hub/providers';
import { aesGcmDecrypt } from '@hub/crypto';
import {
  RawWebhookRequest,
  IngestResult,
  ProviderType,
  logger,
  generateCorrelationId,
  OutboxPayload,
  TraceIngestedNotice,
} from '@hub/common';
import { Prisma } from '@prisma/client';
import { REJECTED_META_KEY, RejectedRecordLimiter, sampleRejectedBody } from './rejected-sample';
import { redactHeaders } from './redact-headers';
import { ingestDuration, ingestRequests } from '../metrics/metrics';

/**
 * S2-2 (ADR-049): chặng ①–④ (nhận, verify, COMMIT, ACK) chạy trong hub-api -> phát `trace.ingested`
 * THẲNG vào Socket.IO cùng tiến trình, 0 lệnh Redis. RealtimeGateway cài interface này (ADR-021).
 */
export interface TraceNotifier {
  traceIngested(tenantId: string, notice: TraceIngestedNotice): void;
}
export const TRACE_NOTIFIER = Symbol('TRACE_NOTIFIER');

interface TraceState {
  correlationId: string;
  tenantId?: string;
  outcome?: TraceIngestedNotice['outcome'];
  rawEventId?: string;
}

@Injectable()
export class IngestService {
  /** S1-4: trần 20 bản ghi REJECTED/phút/source, trong bộ nhớ (không tốn Redis). */
  private readonly rejectedLimiter = new RejectedRecordLimiter();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Optional() @Inject(TRACE_NOTIFIER) private readonly notifier?: TraceNotifier,
  ) {}

  async ingestWebhook(req: RawWebhookRequest): Promise<{ status: number; body: unknown }> {
    const startedAt = Date.now();
    const trace: TraceState = { correlationId: generateCorrelationId() };
    const result = await this.ingestCore(req, trace);
    this.recordMetrics(req.provider, trace, result.status, startedAt);
    // Chỉ phát khi ĐÃ BIẾT tenant (source tồn tại) — 404/400/413 không phát gì. Best-effort.
    if (trace.tenantId && trace.outcome && this.notifier) {
      try {
        this.notifier.traceIngested(trace.tenantId, {
          correlationId: trace.correlationId,
          provider: req.provider,
          sourceKey: req.sourceKey,
          httpStatus: result.status,
          outcome: trace.outcome,
          rawEventId: trace.rawEventId,
          ms: Date.now() - startedAt,
        });
      } catch (err: any) {
        logger.warn({ err: err?.message }, 'Không phát được trace.ingested (bỏ qua)');
      }
    }
    return result;
  }

  /**
   * S3-4: đếm trong bộ nhớ (0 lệnh Redis). Nhãn `provider` chỉ nhận provider ĐÃ ĐĂNG KÝ — path
   * `/hooks/:provider` do client gửi, để nguyên thì kẻ xấu làm nổ số chuỗi thời gian (cardinality).
   */
  private recordMetrics(provider: string, trace: TraceState, status: number, startedAt: number) {
    try {
      let label = 'unknown';
      try {
        label = ProviderRegistry.get(provider as ProviderType).provider;
      } catch {
        /* provider lạ -> 'unknown' */
      }
      const outcome = trace.outcome ?? (status === 404 ? 'NOT_FOUND' : status === 413 ? 'TOO_LARGE' : 'INVALID');
      ingestRequests.inc({ provider: label, outcome });
      ingestDuration.observe({ provider: label }, (Date.now() - startedAt) / 1000);
    } catch {
      /* metric không bao giờ làm hỏng ingest */
    }
  }

  private async ingestCore(req: RawWebhookRequest, trace: TraceState): Promise<{ status: number; body: unknown }> {
    const correlationId = trace.correlationId;
    const log = logger.child({
      correlationId,
      provider: req.provider,
      sourceKey: req.sourceKey,
    });

    // 1. Kiểm tra kích thước payload <= 1MB
    const MAX_PAYLOAD_BYTES = 1024 * 1024;
    if (req.rawBody.length > MAX_PAYLOAD_BYTES) {
      log.warn('Payload vượt quá giới hạn 1MB');
      return { status: 413, body: { error: 'Payload quá lớn (tối đa 1MB)' } };
    }

    // Nạp adapter
    let adapter;
    try {
      adapter = ProviderRegistry.get(req.provider);
    } catch (err: any) {
      log.error({ err: err.message }, 'Không tìm thấy adapter cho provider');
      return { status: 400, body: { error: err.message } };
    }

    // 2. Nạp source và secrets từ DB — đây là bước XÁC ĐỊNH tenant (tenant chưa
    // biết tới khi tìm ra source qua sourceKey), nên KHÔNG đi qua
    // TenantScopedRepository (repo đòi tenantId sẵn có). Dùng escape hatch riêng
    // trên PrismaService thay vì gọi thẳng model — BB-5 vẫn giữ nguyên vì đây là
    // điểm duy nhất được phép truy vấn `source` không scope.
    const source = await this.prisma.findSourceBySourceKeyForIngest(req.sourceKey);

    if (!source || !source.isActive) {
      log.warn('Source không tồn tại hoặc đã bị vô hiệu hóa');
      return { status: 404, body: { error: 'Source webhook không hợp lệ hoặc đã tắt' } };
    }
    trace.tenantId = source.tenantId;

    // 2b. Rate limit theo source (cửa sổ cố định 60s, INCR+EXPIRE)
    const rateLimitKey = `rate:source:${source.id}`;
    // S3-4: trần cấu hình được (`INGEST_RATE_LIMIT_PER_MIN`, mặc định 100/phút/source) — k6 cần nâng trần.
    const allowed = await this.redis.checkRateLimit(rateLimitKey, ingestRateLimitPerMin(), 60);
    if (!allowed) {
      log.warn('Bị chặn bởi Rate Limit theo Source');
      trace.outcome = 'RATE_LIMITED';
      return { status: 429, body: { error: 'Vượt quá tần suất cho phép (Rate limit)' } };
    }

    // Giải mã danh sách secrets còn hiệu lực
    const masterKey = getMasterKey();
    const decryptedSecrets = source.secrets.map((s) => {
      try {
        return aesGcmDecrypt(s.secretEncrypted, masterKey);
      } catch (e) {
        log.error({ secretId: s.id }, 'Không thể giải mã secret của source');
        return '';
      }
    }).filter(Boolean);

    // 3. Adapter xác thực chữ ký (verify)
    const isSignatureValid = await adapter.verify(req, decryptedSecrets);
    // ADR-051: verify đã xong -> từ đây chỉ lưu bản headers ĐÃ che (Authorization/Cookie/X-API-Key...).
    // `req.headers` gốc vẫn còn cho adapter (extractIdempotencyKey/buildAck); bodyRaw giữ nguyên bytes.
    const storedHeaders = redactHeaders(req.headers as Record<string, unknown>);
    // S3-1: adapter tự biết chữ ký của mình ở đâu (header GitHub/Stripe, body PayOS, SePay đã che).
    // Lõi không đoán header -> thêm provider không phải sửa dòng này.
    const signatureHeader = adapter.extractSignature(req);
    if (!isSignatureValid) {
      log.warn('Chữ ký webhook không hợp lệ! Lưu raw_event với status REJECTED');
      // Lưu MẪU request lỗi để điều tra (§7.1) — có giới hạn (S1-4): tối đa 4KB body và
      // 20 bản ghi/phút/source. Vượt trần vẫn trả 401, chỉ không ghi DB.
      if (!this.rejectedLimiter.tryAcquire(source.id)) {
        log.warn({ sourceId: source.id }, 'Vượt trần 20 bản ghi REJECTED/phút cho source này -> không lưu raw_event, chỉ log');
      } else {
        const sample = sampleRejectedBody(req.rawBody, req.body);
        try {
          await this.prisma.rawEvent.create({
            data: {
              sourceId: source.id,
              idempotencyKey: `rejected_${correlationId}`,
              headers: { ...(storedHeaders as any), [REJECTED_META_KEY]: sample.meta },
              body: sample.body as any,
              bodyRaw: new Uint8Array(sample.bodyRaw),
              contentType: req.contentType,
              signatureHeader,
              signatureValid: false,
              status: 'REJECTED',
              origin: 'webhook',
            },
          });
        } catch (err) {
          log.error({ err }, 'Lỗi khi lưu rejected raw_event');
        }
      }

      trace.outcome = 'REJECTED';
      return { status: 401, body: { error: 'Chữ ký webhook không hợp lệ (Unauthorized)' } };
    }

    // 4. Trích xuất Idempotency Key
    const idempotencyKey = adapter.extractIdempotencyKey(req);

    // 5. Đường tắt Redis (BB-2: Chỉ đọc, nếu hit -> duplicate ACK)
    const redisIdemKey = `idem:${source.id}:${idempotencyKey}`;
    const cachedHit = await this.redis.getIdempotencyKey(redisIdemKey);
    if (cachedHit) {
      log.info({ idempotencyKey }, 'Chống trùng lớp 1 (Redis Cache Hit): Webhook đã được nhận trước đó');
      trace.outcome = 'DUPLICATE';
      return adapter.buildAck({
        accepted: true,
        status: 200,
        isDuplicate: true,
        idempotencyKey,
      });
    }

    // 6. Transaction: PostgreSQL là trọng tài (BB-2 + BB-3)
    let rawEventRecord;
    try {
      rawEventRecord = await this.prisma.$transaction(async (tx) => {
        // Ghi raw_events
        const rawEvent = await tx.rawEvent.create({
          data: {
            sourceId: source.id,
            idempotencyKey,
            headers: storedHeaders as any,
            body: typeof req.body === 'object' && req.body !== null ? req.body : {},
            bodyRaw: new Uint8Array(req.rawBody),
            contentType: req.contentType,
            signatureHeader,
            signatureValid: true,
            status: 'ACCEPTED',
            origin: 'webhook',
          },
        });

        // Ghi transactional outbox trong CÙNG transaction
        const outboxPayload: OutboxPayload = {
          rawEventId: rawEvent.id,
          sourceId: source.id,
          tenantId: source.tenantId,
          provider: req.provider,
          correlationId,
        };

        await tx.outbox.create({
          data: {
            topic: 'event.received',
            payload: outboxPayload as any,
          },
        });

        return rawEvent;
      });
    } catch (error: any) {
      // Bắt lỗi trùng lặp PostgreSQL UNIQUE(source_id, idempotency_key)
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        log.info({ idempotencyKey }, 'Chống trùng lớp 2 (PostgreSQL Unique Violation): Bỏ qua webhook trùng lặp');
        trace.outcome = 'DUPLICATE';
        return adapter.buildAck({
          accepted: true,
          status: 200,
          isDuplicate: true,
          idempotencyKey,
        });
      }

      log.error({ err: error.message }, 'Lỗi transaction khi lưu raw_event và outbox');
      trace.outcome = 'ERROR';
      return { status: 500, body: { error: 'Lỗi máy chủ nội bộ khi lưu sự kiện' } };
    }

    // 7. Sau khi COMMIT thành công: Cập nhật đường tắt Redis (BB-3)
    await this.redis.setIdempotencyKey(redisIdemKey, rawEventRecord.id, 86400);

    log.info({ rawEventId: rawEventRecord.id }, 'Đã tiếp nhận và commit thành công webhook vào Outbox');

    // 8. Trả ACK thành công theo định dạng của provider
    trace.outcome = 'ACCEPTED';
    trace.rawEventId = rawEventRecord.id;
    return adapter.buildAck({
      accepted: true,
      status: 200,
      rawEventId: rawEventRecord.id,
      idempotencyKey,
      isDuplicate: false,
    });
  }
}

/** Trần request/phút/source (mặc định 100). Giá trị không hợp lệ -> 100. */
export function ingestRateLimitPerMin(v: string | undefined = process.env.INGEST_RATE_LIMIT_PER_MIN): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : 100;
}
