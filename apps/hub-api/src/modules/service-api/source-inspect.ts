import { NotFoundException } from '@nestjs/common';
import { ProviderRegistry } from '@hub/providers';
import { unprocessable } from './service-api.controller';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Repo đã scope theo tenant (`prisma.forTenant(tenantId)`, BB-5) — chỉ hai hàm cần dùng. */
export interface InspectRepo {
  findSourceById(id: string): Promise<unknown>;
  /** Không nạp `body_raw` (review PK1 T-4). */
  findRecentRawEventsForInspect(sourceId: string, since: Date, limit: number): Promise<any[]>;
}

export interface InspectRow {
  id: string;
  receivedAt: Date;
  status: string;
  diagnosis: unknown;
  /**
   * PK4 (§6.1, ADR-205): dòng bắt tay (`__hub_meta.reason='handshake'`) — `kind`, và với `manual-url` thì `subscribeUrl`
   * (link SNS cho dev tự bấm; hub KHÔNG gọi ra). Ngoại lệ có chủ đích duy nhất của "không trả giá trị".
   */
  handshake?: { kind: string; subscribeUrl?: string | null };
}

/** PK4: meta bắt tay của dòng REJECTED (`headers.__hub_meta`), không có -> null. */
function handshakeOf(headers: unknown): InspectRow['handshake'] | null {
  const meta = headers && typeof headers === 'object' ? (headers as Record<string, any>).__hub_meta : null;
  if (!meta || meta.reason !== 'handshake') return null;
  const h = meta.handshake && typeof meta.handshake === 'object' ? meta.handshake : {};
  const kind = typeof h.kind === 'string' ? h.kind.slice(0, 32) : 'unknown';
  return kind === 'manual-url' ? { kind, subscribeUrl: typeof h.subscribeUrl === 'string' ? h.subscribeUrl : null } : { kind };
}

/**
 * S9 (SPEC §4.8) + PK1 (SPEC-provider-khac §3.2, ADR-202): chế độ lắng nghe — 10 raw_events mới nhất của source
 * (`received_at >= since`), mỗi dòng kèm chẩn đoán của adapter (không cài `diagnose` -> `{ok: signatureValid}`).
 * MỘT hàm cho cả `GET /v1/p/:project/sources/:id/inspect` (service) và `GET /api/v1/sources/:id/inspect` (console):
 * cùng khuôn, cùng 404/422. KHÔNG BAO GIỜ trả giá trị chữ ký, token, secret, header hay body — chỉ tên header/trường.
 */
export async function inspectSourceRows(repo: InspectRepo, id: string, since?: string): Promise<InspectRow[]> {
  const source = (UUID_RE.test(id) ? await repo.findSourceById(id) : null) as { id: string; provider: string; verificationConfig?: unknown } | null;
  if (!source) throw new NotFoundException({ error: 'not_found' });
  let from = new Date(0);
  if (since !== undefined) {
    from = new Date(since);
    if (!/^\d{4}-\d{2}-\d{2}/.test(since) || Number.isNaN(from.getTime())) {
      unprocessable({ error: 'validation_failed', field: 'since', message: 'since là thời điểm ISO 8601 (vd 2026-10-10T00:00:00Z)' });
    }
  }
  const adapter = ProviderRegistry.get(source.provider as any);
  const ctx = { verificationConfig: source.verificationConfig ?? undefined };
  const rows = await repo.findRecentRawEventsForInspect(source.id, from, 10);
  return rows.map((r) => {
    // PK4 (E8): dòng bắt tay không phải "thiếu khoá chống trùng" — chẩn đoán `handshake`, kèm meta cho tab Lắng nghe.
    const handshake = handshakeOf(r.headers);
    if (handshake) return { id: r.id, receivedAt: r.receivedAt, status: r.status, diagnosis: { ok: true, reason: 'handshake' }, handshake };
    return {
      id: r.id,
      receivedAt: r.receivedAt,
      status: r.status,
      diagnosis: adapter.diagnose ? adapter.diagnose(r, ctx) : { ok: r.signatureValid },
    };
  });
}
