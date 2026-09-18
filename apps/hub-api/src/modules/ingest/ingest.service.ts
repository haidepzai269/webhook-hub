import { Injectable } from '@nestjs/common';
import { PrismaService, DEV_MASTER_KEY } from '@hub/database';
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
} from '@hub/common';
import { Prisma } from '@prisma/client';

@Injectable()
export class IngestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async ingestWebhook(req: RawWebhookRequest): Promise<{ status: number; body: unknown }> {
    const correlationId = generateCorrelationId();
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

    // 2. Nạp source và secrets từ DB
    const source = await this.prisma.source.findUnique({
      where: { sourceKey: req.sourceKey },
      include: {
        secrets: {
          where: {
            OR: [
              { validUntil: null },
              { validUntil: { gt: new Date() } },
            ],
          },
        },
      },
    });

    if (!source || !source.isActive) {
      log.warn('Source không tồn tại hoặc đã bị vô hiệu hóa');
      return { status: 404, body: { error: 'Source webhook không hợp lệ hoặc đã tắt' } };
    }

    // 2b. Rate limit token bucket theo source
    const rateLimitKey = `rate:source:${source.id}`;
    const allowed = await this.redis.checkRateLimit(rateLimitKey, 100, 60); // 100 req/phút
    if (!allowed) {
      log.warn('Bị chặn bởi Rate Limit theo Source');
      return { status: 429, body: { error: 'Vượt quá tần suất cho phép (Rate limit)' } };
    }

    // Giải mã danh sách secrets còn hiệu lực
    const masterKey = process.env.MASTER_KEY || DEV_MASTER_KEY;
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
    if (!isSignatureValid) {
      log.warn('Chữ ký webhook không hợp lệ! Lưu raw_event với status REJECTED');
      // Lưu lại request lỗi để tra cứu điều tra theo ARCHITECTURE.md §7.1
      try {
        await this.prisma.rawEvent.create({
          data: {
            sourceId: source.id,
            idempotencyKey: `rejected_${correlationId}`,
            headers: req.headers as any,
            body: typeof req.body === 'object' && req.body !== null ? req.body : {},
            bodyRaw: new Uint8Array(req.rawBody),
            contentType: req.contentType,
            signatureHeader: JSON.stringify(req.headers['x-hub-signature-256'] || req.headers['authorization'] || ''),
            signatureValid: false,
            status: 'REJECTED',
            origin: 'webhook',
          },
        });
      } catch (err) {
        log.error({ err }, 'Lỗi khi lưu rejected raw_event');
      }

      return { status: 401, body: { error: 'Chữ ký webhook không hợp lệ (Unauthorized)' } };
    }

    // 4. Trích xuất Idempotency Key
    const idempotencyKey = adapter.extractIdempotencyKey(req);

    // 5. Đường tắt Redis (BB-2: Chỉ đọc, nếu hit -> duplicate ACK)
    const redisIdemKey = `idem:${source.id}:${idempotencyKey}`;
    const cachedHit = await this.redis.getIdempotencyKey(redisIdemKey);
    if (cachedHit) {
      log.info({ idempotencyKey }, 'Chống trùng lớp 1 (Redis Cache Hit): Webhook đã được nhận trước đó');
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
            headers: req.headers as any,
            body: typeof req.body === 'object' && req.body !== null ? req.body : {},
            bodyRaw: new Uint8Array(req.rawBody),
            contentType: req.contentType,
            signatureHeader: JSON.stringify(req.headers['x-hub-signature-256'] || req.headers['authorization'] || ''),
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
        return adapter.buildAck({
          accepted: true,
          status: 200,
          isDuplicate: true,
          idempotencyKey,
        });
      }

      log.error({ err: error.message }, 'Lỗi transaction khi lưu raw_event và outbox');
      return { status: 500, body: { error: 'Lỗi máy chủ nội bộ khi lưu sự kiện' } };
    }

    // 7. Sau khi COMMIT thành công: Cập nhật đường tắt Redis (BB-3)
    await this.redis.setIdempotencyKey(redisIdemKey, rawEventRecord.id, 86400);

    log.info({ rawEventId: rawEventRecord.id }, 'Đã tiếp nhận và commit thành công webhook vào Outbox');

    // 8. Trả ACK thành công theo định dạng của provider
    return adapter.buildAck({
      accepted: true,
      status: 200,
      rawEventId: rawEventRecord.id,
      idempotencyKey,
      isDuplicate: false,
    });
  }
}
