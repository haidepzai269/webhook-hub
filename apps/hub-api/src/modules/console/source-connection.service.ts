import { HttpException, HttpStatus } from '@nestjs/common';
import * as net from 'net';
import { ulid } from 'ulidx';
import { PrismaService, TenantScopedRepository, getMasterKey } from '@hub/database';
import { aesGcmDecrypt, aesGcmEncrypt, isLinkLocalIp, isPrivateIp } from '@hub/crypto';
import { logger } from '@hub/common';
import { ConnectorError, ProviderConnector, ProviderRegistry, connectorBaseUrl } from '@hub/providers';
import { unprocessable } from '../service-api/service-api.controller';
import { hubError } from '../errors/hub-error';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_KEY_RE = /^[a-z0-9_]{3,64}$/;
/** `GET …/connection` gọi `status?` của provider tối đa 1 lần / phút / kết nối (đọc `last_checked_at`, 0 lệnh Redis). */
export const STATUS_CHECK_INTERVAL_MS = 60_000;
/** Provider sinh secret mới khi kết nối lại (Stripe) -> secret cũ còn verify thêm 24 giờ (thời gian chồng). */
export const SECRET_OVERLAP_MS = 24 * 60 * 60_000;
/**
 * L-3: kết nối PENDING cập nhật trong khoảng này = một lượt khác đang gọi provider -> 409 `connection_in_progress`.
 * PENDING cũ hơn = kẹt (tiến trình chết giữa chừng / TX ghi kết quả lỗi) -> cho bấm lại. Lớn hơn timeout `connectorFetch` (20s).
 */
export const PENDING_STALE_MS = 60_000;
/** H-R2-1: số raw_events gần nhất (từ lúc có secret do người dùng nhập) đem verify lại khi kiểm tình trạng. */
export const SECRET_EVIDENCE_SAMPLE = 20;
const SECRET_MISMATCH_FIX =
  'checksumKey vừa nhập KHÔNG khớp webhook thật (provider vẫn ký bằng key cũ) — hub giữ cả hai key nên không mất sự kiện. Nhập lại đúng checksumKey rồi bấm "Thử lại".';

const notFound = () => hubError('not_found', {}, 'Source không tồn tại');
const inProgress = () => hubError('conflict', { code: 'connection_in_progress' }, 'Đang kết nối với provider (một lượt khác vừa bấm) — đợi kết quả rồi tải lại');
/** L-1: `source_key` UNIQUE toàn cục -> body GIỐNG HỆT dù key thuộc project mình hay project khác (không dò được key của người khác). */
const sourceKeyTaken = () => hubError('conflict', { field: 'sourceKey', code: 'source_key_taken' }, 'sourceKey đã được dùng — chọn key khác hoặc bỏ trống để hub tự sinh');
const isUniqueViolation = (e: unknown) => (e as { code?: unknown })?.code === 'P2002';

function publicSource(source: any) {
  const { secrets, ...rest } = source;
  return { ...rest, secretVersions: Array.isArray(secrets) ? secrets.length : 0, webhookUrl: `/hooks/${source.provider}/${source.sourceKey}` };
}

/**
 * KN2 (SPEC-ket-noi §4.4): URL công khai mà provider gọi vào. `HUB_PUBLIC_URL` là localhost / IP nội bộ / tên một nhãn
 * (vd `hub-api` trong docker) -> null (422 `public_url_required`, KHÔNG gọi provider).
 * Ngoài production, `CONNECTOR_INGEST_BASE_URL` thay hẳn (stack kiểm chứng: fake provider trong sink gọi `http://hub-api:4000`);
 * production có biến này -> app không khởi động (testOnlyConfigProblems).
 */
export function publicIngestBase(env: Record<string, string | undefined> = process.env): string | null {
  const override = env.NODE_ENV === 'production' ? '' : (env.CONNECTOR_INGEST_BASE_URL ?? '').trim();
  if (override) return override.replace(/\/$/, '');
  const raw = (env.HUB_PUBLIC_URL ?? '').trim().replace(/\/$/, '');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home)$/.test(host)) return null;
  if (net.isIP(host)) return isPrivateIp(host) || isLinkLocalIp(host) ? null : raw;
  if (!host.includes('.')) return null;
  return raw;
}

function lastN(v: string, n = 4): string {
  return v.length <= n ? '****' : `****${v.slice(-n)}`;
}

/** Đọc credentials theo `spec.fields`: đủ trường, chuỗi 1–512 ký tự; trường lạ bị bỏ (không lưu thứ không khai). */
function parseCredentials(connector: ProviderConnector, v: unknown): Record<string, string> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    unprocessable({ error: 'validation_failed', field: 'credentials', message: 'credentials là object theo các ô của connector' });
  }
  const out: Record<string, string> = {};
  for (const f of connector.spec.fields) {
    const x = (v as Record<string, unknown>)[f.name];
    if (typeof x !== 'string' || !x.trim() || x.length > 512) {
      unprocessable({ error: 'validation_failed', field: `credentials.${f.name}`, message: `Thiếu hoặc sai "${f.label}"` });
    }
    out[f.name] = (x as string).trim();
  }
  return out;
}

export interface ConnectionView {
  sourceId: string;
  provider: string;
  status: string;
  display: string | null;
  ingestUrl: string;
  lastError: string | null;
  fix: string | null;
  connectedAt: Date | null;
  lastCheckedAt: Date | null;
  /** Không bao giờ là credentials: chỉ cờ + 4 ký tự cuối của từng trường bí mật (§4.3 điều 2). */
  hasCredentials: boolean;
  credentialHints: Record<string, string>;
  manualDisconnect: string | null;
}

/**
 * KN2 (SPEC-ket-noi §4, ADR-138): hub tự đăng ký URL ingest của source tại provider (biến thể A). Lõi chỉ hỏi
 * `adapter.connector` — mọi chi tiết provider nằm trong connector của adapter (BB-1, không `if (provider === …)`).
 * Thứ tự cố định (cạm bẫy 4): source + SourceSecret + kết nối PENDING COMMIT TRƯỚC, rồi mới gọi provider NGOÀI tx —
 * provider bắn request kiểm tra vào ingest NGAY lúc đăng ký, source phải tồn tại và verify được.
 * Credentials mã hoá (AES-GCM, MASTER_KEY), chỉ giải mã ở đây; audit/log chỉ có TÊN trường.
 */
export class SourceConnectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  /** UI dựng form từ `spec.fields` — chỉ provider có connector. */
  listConnectors() {
    return ProviderRegistry.all()
      .filter((a) => a.connector)
      .map((a) => {
        const s = a.connector!.spec;
        return { provider: a.provider, fields: s.fields, overwriteWarning: s.overwriteWarning ?? null, keyHint: s.keyHint, manualDisconnect: s.manualDisconnect ?? null };
      });
  }

  async connect(tenantId: string, actor: string, body: any) {
    // H-1: `sourceId` trong body = gắn vào source CÓ SẴN (giống `POST /sources/:id/connect`).
    if (body?.sourceId !== undefined && body?.sourceId !== null && body?.sourceId !== '') return this.connectExisting(tenantId, actor, body.sourceId, body);
    const provider = body?.provider;
    if (!ProviderRegistry.has(provider)) unprocessable({ error: 'validation_failed', field: 'provider', message: 'provider không hợp lệ' });
    const connector = ProviderRegistry.get(provider).connector;
    if (!connector) throw hubError('connector_unsupported', { provider }, 'Provider này chưa tự kết nối được — tạo source rồi dán URL ở dashboard provider');
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 255) unprocessable({ error: 'validation_failed', field: 'name', message: 'name là chuỗi 1–255 ký tự' });
    const sourceKey = body?.sourceKey === undefined || body?.sourceKey === null || body?.sourceKey === '' ? `src_${provider}_${ulid().toLowerCase()}` : body.sourceKey;
    if (typeof sourceKey !== 'string' || !SOURCE_KEY_RE.test(sourceKey)) {
      unprocessable({ error: 'validation_failed', field: 'sourceKey', message: 'sourceKey: 3–64 ký tự a-z 0-9 _' });
    }
    const credentials = parseCredentials(connector, body?.credentials);
    this.requireAck(connector, body);
    const base = publicIngestBase(this.env);
    if (!base) throw hubError('public_url_required', {}, 'HUB_PUBLIC_URL là localhost/IP nội bộ — provider không gọi vào được');
    const ingestUrl = `${base}/hooks/${provider}/${sourceKey}`;
    const masterKey = getMasterKey();
    const secretForSource = connector.spec.sourceSecretField ? credentials[connector.spec.sourceSecretField] : undefined;

    // (3) TX: Source (+ SourceSecret v1 nếu secret ký có sẵn) + kết nối PENDING + audit -> COMMIT TRƯỚC khi gọi provider.
    const source = await this.tx(tenantId, async (repo) => {
      const s = await repo.createSource({
        provider,
        name,
        sourceKey,
        isActive: true,
        ...(secretForSource ? { secrets: { create: { secretEncrypted: aesGcmEncrypt(secretForSource, masterKey), version: 1 } } } : {}),
      } as any);
      await repo.createSourceConnection({
        sourceId: s.id,
        provider,
        credentialsEncrypted: aesGcmEncrypt(JSON.stringify(credentials), masterKey),
        status: 'PENDING',
        ingestUrl,
      });
      await repo.createAuditLog({ action: 'source.create', entityType: 'source', entityId: s.id, actor, metadata: { provider, name, sourceKey, via: 'connect' } });
      return s;
    }).catch((e) => {
      if (isUniqueViolation(e)) throw sourceKeyTaken();
      throw e;
    });
    // (4)+(5) NGOÀI tx: gọi provider, rồi ghi kết quả (FAILED vẫn giữ source — "Thử lại" không phải nhập lại).
    const view = await this.callConnect(tenantId, actor, source.id, provider, connector, credentials, ingestUrl, 'source.connect', null);
    const { secretVersions: _v, ...src } = publicSource(source);
    return { source: src, connection: view };
  }

  /**
   * H-1 (REVIEW-KN, ADR-151): gắn connector vào source CÓ SẴN của project (vd `src_payos_main` mà Shop ghim trong
   * `SHOP_PAYMENT_SOURCE_KEYS`) — URL đăng ký tại provider là `/hooks/<provider>/<sourceKey cũ>`, nên service đang tin
   * source đó vẫn nhận. Cùng luật với `connect`: secret ký (checksumKey) thành SourceSecret version mới nếu khác bản hiện
   * hành (bản cũ còn 24 giờ), COMMIT trước rồi mới gọi provider; source project khác -> 404 giống hệt id lạ.
   * Source đã có kết nối -> kết nối lại trên chính nó (như "Thử lại" với credentials mới).
   */
  async connectExisting(tenantId: string, actor: string, sourceId: unknown, body: any) {
    if (typeof sourceId !== 'string' || !UUID_RE.test(sourceId)) throw notFound();
    const source: any = await this.prisma.forTenant(tenantId).findSourceById(sourceId);
    if (!source) throw notFound();
    if (body?.provider !== undefined && body?.provider !== source.provider) {
      unprocessable({ error: 'validation_failed', field: 'provider', message: 'provider phải trùng provider của source có sẵn' });
    }
    const connector = ProviderRegistry.has(source.provider) ? ProviderRegistry.get(source.provider).connector : undefined;
    if (!connector) throw hubError('connector_unsupported', { provider: source.provider }, 'Provider này chưa tự kết nối được — dán URL ở dashboard provider');
    if (!source.isActive) unprocessable({ error: 'validation_failed', field: 'sourceId', message: 'Source đang tắt — bật lại trước khi kết nối' });
    const credentials = parseCredentials(connector, body?.credentials);
    this.requireAck(connector, body);
    const existing = await this.prisma.forTenant(tenantId).findSourceConnection(source.id);
    if (existing) {
      const r = await this.retry(tenantId, actor, source.id, { credentials });
      return { source: publicSource(source), connection: r.connection, secretChanged: r.secretChanged };
    }
    const base = publicIngestBase(this.env);
    if (!base) throw hubError('public_url_required', {}, 'HUB_PUBLIC_URL là localhost/IP nội bộ — provider không gọi vào được');
    const ingestUrl = `${base}/hooks/${source.provider}/${source.sourceKey}`;
    const secretForSource = connector.spec.sourceSecretField ? credentials[connector.spec.sourceSecretField] : undefined;
    const masterKey = getMasterKey();
    // (3) TX: SourceSecret version mới (nếu cần) + kết nối PENDING -> COMMIT TRƯỚC khi gọi provider.
    // H-R2-1: secret do NGƯỜI DÙNG nhập -> KHÔNG hẹn hết hạn bản cũ (PayOS confirm không kiểm checksumKey: key dán sai vẫn
    // CONNECTED). Bản cũ chỉ bị retire khi webhook thật verify bằng key mới (`reconcileUserSecret`, lúc kiểm tình trạng).
    const secretChanged = !!secretForSource && !this.currentSecrets(source).includes(secretForSource);
    await this.tx(tenantId, async (repo) => {
      if (secretChanged) await repo.addSourceSecret(source.id, aesGcmEncrypt(secretForSource!, masterKey));
      await repo.createSourceConnection({
        sourceId: source.id,
        provider: source.provider,
        credentialsEncrypted: aesGcmEncrypt(JSON.stringify(credentials), masterKey),
        status: 'PENDING',
        ingestUrl,
      });
    }).catch((e) => {
      // Hai lượt bấm cùng lúc: `source_id` UNIQUE -> lượt thua.
      if (isUniqueViolation(e)) throw inProgress();
      throw e;
    });
    const view = await this.callConnect(tenantId, actor, source.id, source.provider, connector, credentials, ingestUrl, 'source.connect', null);
    return { source: publicSource(source), connection: view, secretChanged };
  }

  /** "Thử lại" / kết nối lại: credentials trong body (đổi) hoặc bản đã lưu. Đã xoá credentials mà không gửi -> 422 `credentials_required`. */
  async retry(tenantId: string, actor: string, sourceId: string, body: any) {
    const { source, conn, connector } = await this.load(tenantId, sourceId);
    let credentials: Record<string, string>;
    if (body?.credentials !== undefined) credentials = parseCredentials(connector, body.credentials);
    else {
      const stored = this.decrypt(conn.credentialsEncrypted);
      if (!stored) throw hubError('credentials_required', {}, 'Credentials đã bị xoá — nhập lại để kết nối');
      credentials = stored;
    }
    const base = publicIngestBase(this.env);
    if (!base) throw hubError('public_url_required', {}, 'HUB_PUBLIC_URL là localhost/IP nội bộ — provider không gọi vào được');
    const ingestUrl = `${base}/hooks/${source.provider}/${source.sourceKey}`;
    const secretForSource = connector.spec.sourceSecretField ? credentials[connector.spec.sourceSecretField] : undefined;
    const secretChanged = !!secretForSource && !this.currentSecrets(source).includes(secretForSource);
    const masterKey = getMasterKey();
    await this.tx(tenantId, async (repo) => {
      // L-3: giành kết nối TRƯỚC (UPDATE có điều kiện) — lượt khác đang PENDING -> 409, không đụng secret.
      const claimed = await repo.claimSourceConnection(source.id, new Date(Date.now() - PENDING_STALE_MS), {
        credentialsEncrypted: aesGcmEncrypt(JSON.stringify(credentials), masterKey),
        ingestUrl,
      });
      if (!claimed) throw inProgress();
      // Secret ký do dev nhập đổi (vd checksumKey mới) -> version mới TRƯỚC khi gọi provider (request kiểm tra phải verify được).
      // H-R2-1: KHÔNG hẹn hết hạn bản cũ — xem connectExisting.
      if (secretChanged) await repo.addSourceSecret(source.id, aesGcmEncrypt(secretForSource!, masterKey));
    });
    const action = conn.status === 'CONNECTED' || conn.status === 'DRIFTED' ? 'source.reconnect' : 'source.connect';
    const view = await this.callConnect(tenantId, actor, source.id, source.provider, connector, credentials, ingestUrl, action, conn.remoteRef);
    return { connection: view, secretChanged };
  }

  async status(tenantId: string, sourceId: string): Promise<ConnectionView> {
    const { source, conn, connector } = await this.load(tenantId, sourceId);
    const base = publicIngestBase(this.env);
    const expected = base ? `${base}/hooks/${source.provider}/${source.sourceKey}` : null;
    const due = !conn.lastCheckedAt || Date.now() - new Date(conn.lastCheckedAt).getTime() >= STATUS_CHECK_INTERVAL_MS;
    let next = conn;
    if (due) {
      let status = conn.status;
      let lastError: string | null = conn.lastError;
      let lastFix: string | null = conn.lastFix;
      const live = conn.status === 'CONNECTED' || conn.status === 'DRIFTED';
      if (!live) {
        // FAILED / PENDING / DISCONNECTED: không hỏi provider; chỉ đối chiếu secret bên dưới.
      } else if (expected && expected !== conn.ingestUrl) {
        // HUB_PUBLIC_URL đổi (đổi domain) -> provider vẫn gọi URL cũ.
        status = 'DRIFTED';
        lastError = 'public_url_changed';
        lastFix = 'HUB_PUBLIC_URL đã đổi — bấm "Kết nối lại" để đăng ký URL mới tại provider.';
      } else if (connector.status && conn.remoteRef) {
        const creds = this.decrypt(conn.credentialsEncrypted);
        if (creds) {
          try {
            const r = await connector.status({ credentials: creds, remoteRef: conn.remoteRef, ingestUrl: conn.ingestUrl, baseUrl: connectorBaseUrl(connector.spec, this.env) });
            status = r === 'ok' ? 'CONNECTED' : r === 'drifted' ? 'DRIFTED' : 'FAILED';
            lastError = r === 'ok' ? null : r === 'drifted' ? 'remote_url_changed' : 'remote_gone';
            lastFix = r === 'ok' ? null : r === 'drifted' ? 'URL ở provider không còn là URL của hub — bấm "Kết nối lại".' : 'Cấu hình ở provider đã bị xoá — bấm "Kết nối lại".';
          } catch (e) {
            logger.warn({ sourceId, provider: source.provider, error: e instanceof ConnectorError ? e.code : 'status_failed' }, 'Kiểm tình trạng kết nối thất bại');
          }
        }
      }
      const evidence = await this.reconcileUserSecret(tenantId, source, conn, connector).catch((e) => {
        logger.warn({ sourceId, provider: source.provider, error: (e as Error)?.name ?? 'reconcile_failed' }, 'Đối chiếu secret thất bại');
        return null;
      });
      if (evidence === 'mismatch' && (!lastError || lastError === 'secret_mismatch')) {
        lastError = 'secret_mismatch';
        lastFix = SECRET_MISMATCH_FIX;
      } else if (evidence === 'confirmed' && lastError === 'secret_mismatch') {
        lastError = null;
        lastFix = null;
      }
      // L-R3-1: compare-and-set trên (status, updatedAt) đã đọc — lượt connect/retry ghi xen giữa thì KHÔNG đè, đọc lại bản mới.
      next =
        (await this.tx(tenantId, (repo) =>
          repo.updateSourceConnectionIf(sourceId, { status: conn.status, updatedAt: conn.updatedAt }, { status, lastError, lastFix, lastCheckedAt: new Date() }),
        )) ??
        (await this.prisma.forTenant(tenantId).findSourceConnection(sourceId)) ??
        conn;
    }
    return this.view(next, connector);
  }

  async disconnect(tenantId: string, actor: string, sourceId: string) {
    const { source, conn, connector } = await this.load(tenantId, sourceId);
    let remoteDeleted = false;
    const creds = this.decrypt(conn.credentialsEncrypted);
    if (connector.disconnect && creds && conn.remoteRef) {
      try {
        await connector.disconnect({ credentials: creds, remoteRef: conn.remoteRef, baseUrl: connectorBaseUrl(connector.spec, this.env) });
        remoteDeleted = true;
      } catch (e) {
        const code = e instanceof ConnectorError ? e.code : 'provider_unreachable';
        logger.warn({ sourceId, provider: source.provider, error: code }, 'Ngắt kết nối phía provider thất bại');
        throw new HttpException({ error: 'conflict', message: `Provider từ chối ngắt kết nối (${code}) — thử lại sau` }, HttpStatus.CONFLICT);
      }
    }
    const updated = await this.tx(tenantId, async (repo) => {
      const u = await repo.updateSourceConnection(sourceId, { status: 'DISCONNECTED', lastError: null, lastFix: null });
      await repo.createAuditLog({ action: 'source.disconnect', entityType: 'source', entityId: sourceId, actor, metadata: { provider: source.provider, remoteDeleted } });
      return u;
    });
    return { connection: this.view(updated ?? conn, connector), remoteDeleted };
  }

  /** §4.3 điều 5: xoá cột mã hoá, GIỮ source + kết nối (status giữ nguyên). Kết nối lại phải nhập lại. */
  async deleteCredentials(tenantId: string, actor: string, sourceId: string) {
    const { source, conn, connector } = await this.load(tenantId, sourceId);
    const updated = await this.tx(tenantId, async (repo) => {
      const u = await repo.updateSourceConnection(sourceId, { credentialsEncrypted: null });
      await repo.createAuditLog({
        action: 'source.credentials_delete',
        entityType: 'source',
        entityId: sourceId,
        actor,
        metadata: { provider: source.provider, fields: connector.spec.fields.map((f) => f.name) },
      });
      return u;
    });
    return { connection: this.view(updated ?? conn, connector) };
  }

  // ---------------------------------------------------------------------------------------------------------------

  private requireAck(connector: ProviderConnector, body: any) {
    if (connector.spec.overwriteWarning && body?.acknowledgeOverwrite !== true) {
      throw hubError('overwrite_not_acknowledged', { field: 'acknowledgeOverwrite' }, connector.spec.overwriteWarning);
    }
  }

  private async callConnect(
    tenantId: string,
    actor: string,
    sourceId: string,
    provider: string,
    connector: ProviderConnector,
    credentials: Record<string, string>,
    ingestUrl: string,
    action: 'source.connect' | 'source.reconnect',
    previousRemoteRef: string | null,
  ): Promise<ConnectionView> {
    const baseUrl = connectorBaseUrl(connector.spec, this.env);
    const secretForSource = connector.spec.sourceSecretField ? credentials[connector.spec.sourceSecretField] : undefined;
    let result: { remoteRef: string; display: string; sourceSecret?: string } | null = null;
    let failure: { code: string; fix: string } | null = null;
    try {
      result = await connector.connect({ ingestUrl, credentials, secretForSource, baseUrl });
    } catch (e) {
      failure =
        e instanceof ConnectorError
          ? { code: e.code.slice(0, 255), fix: e.fix }
          : { code: 'provider_unreachable', fix: 'Không gọi được API của provider (mạng/DNS/timeout). Bấm "Thử lại" sau ít phút.' };
      logger.warn({ sourceId, provider, error: failure.code }, 'Kết nối provider thất bại');
    }
    const masterKey = getMasterKey();
    let conn: any;
    try {
      conn = await this.tx(tenantId, async (repo) => {
        if (result?.sourceSecret) {
          // Provider SINH secret ký (Stripe): version mới; các version đang hiệu lực verify thêm 24 giờ (event của cấu hình cũ
          // còn đang gửi lại / secret dán tay trước đây của source có sẵn). Source mới chưa có version nào -> không đổi gì.
          await repo.addSourceSecret(sourceId, aesGcmEncrypt(result.sourceSecret, masterKey), new Date(Date.now() + SECRET_OVERLAP_MS));
        }
        const u = await repo.updateSourceConnection(
          sourceId,
          result
            ? { status: 'CONNECTED', remoteRef: result.remoteRef, display: result.display, lastError: null, lastFix: null, connectedAt: new Date(), lastCheckedAt: new Date() }
            : { status: 'FAILED', lastError: failure!.code, lastFix: failure!.fix },
        );
        await repo.createAuditLog({
          action,
          entityType: 'source',
          entityId: sourceId,
          actor,
          // §4.3 điều 3: CHỈ tên trường — không giá trị credentials, không secret.
          metadata: { provider, status: result ? 'CONNECTED' : 'FAILED', error: failure?.code ?? null, fields: Object.keys(credentials), secretRotated: !!result?.sourceSecret },
        });
        return u;
      });
    } catch (e) {
      // M-1: TX ghi kết quả lỗi (vd pooler rớt). DB vẫn trỏ cấu hình CŨ + secret cũ -> KHÔNG gỡ cấu hình cũ ở provider.
      // Cấu hình MỚI ở provider có secret vừa mất cùng TX (Stripe chỉ trả một lần) -> dọn để nó không bắn event không verify được.
      if (result && result.remoteRef !== previousRemoteRef && connector.disconnect) {
        await connector.disconnect({ credentials, remoteRef: result.remoteRef, baseUrl }).catch((x) => {
          logger.warn({ sourceId, provider, error: x instanceof ConnectorError ? x.code : 'disconnect_failed' }, 'Không dọn được cấu hình mới ở provider sau khi lưu kết quả lỗi');
        });
      }
      await this.tx(tenantId, (repo) =>
        repo.updateSourceConnection(sourceId, { status: 'FAILED', lastError: 'save_failed', lastFix: 'Hub không lưu được kết quả kết nối (DB tạm lỗi) — bấm "Thử lại".' }),
      ).catch(() => undefined);
      throw e;
    }
    // M-1: kết nối lại mà provider cấp id mới -> gỡ cấu hình cũ ở provider (Stripe: xoá we_ cũ) SAU khi COMMIT.
    // Best-effort: lỗi chỉ ghi `last_error` để người dùng gỡ tay; kết nối mới vẫn CONNECTED.
    if (result && previousRemoteRef && previousRemoteRef !== result.remoteRef && connector.disconnect) {
      try {
        await connector.disconnect({ credentials, remoteRef: previousRemoteRef, baseUrl });
      } catch (e) {
        logger.warn({ sourceId, provider, error: e instanceof ConnectorError ? e.code : 'disconnect_failed' }, 'Không gỡ được cấu hình cũ ở provider');
        conn =
          (await this.tx(tenantId, (repo) =>
            repo.updateSourceConnection(sourceId, { lastError: 'previous_remote_not_removed', lastFix: `Không gỡ được cấu hình cũ (${previousRemoteRef}) ở provider — xoá tay ở dashboard provider.` }),
          ).catch(() => null)) ?? conn;
      }
    }
    return this.view(conn, connector);
  }

  private async load(tenantId: string, sourceId: string) {
    if (!UUID_RE.test(sourceId)) throw notFound();
    const repo = this.prisma.forTenant(tenantId);
    const source: any = await repo.findSourceById(sourceId);
    if (!source) throw notFound();
    const conn: any = await repo.findSourceConnection(sourceId);
    const connector = ProviderRegistry.has(source.provider) ? ProviderRegistry.get(source.provider).connector : undefined;
    if (!conn || !connector) throw hubError('not_found', {}, 'Source này chưa có kết nối provider');
    return { source, conn, connector };
  }

  /**
   * H-R2-1 (ADR-152): secret do NGƯỜI DÙNG nhập (`spec.sourceSecretField`, vd checksumKey PayOS) chỉ thay bản cũ khi có
   * BẰNG CHỨNG: webhook thật MỚI NHẤT (raw_events ACCEPTED) verify được bằng một version hiện hành, và đó là key trong
   * credentials (M-R3-1: event mới nhất quyết định, không phải bất kỳ event nào).
   * - event mới nhất khớp key nhập -> retire các version hiện hành KHÁC (+24h cho lượt gửi lại) -> 'confirmed';
   * - event mới nhất chỉ khớp version khác -> 'mismatch' (không retire gì; UI báo nhập sai);
   * - chưa có webhook -> null (giữ cả hai — chiều an toàn).
   * Chạy lười trong lúc kiểm tình trạng (console, ≤ 1 lần/phút/kết nối) — KHÔNG chạm đường ingest: 0 lệnh Redis, không
   * thêm ghi vào TX raw_events (BB-3 giữ nguyên). Secret do provider sinh (Stripe) giữ luật +24h ở `callConnect`.
   */
  private async reconcileUserSecret(tenantId: string, source: any, conn: any, connector: ProviderConnector): Promise<'confirmed' | 'mismatch' | null> {
    const field = connector.spec.sourceSecretField;
    if (!field) return null;
    const entered = this.decrypt(conn.credentialsEncrypted)?.[field];
    if (!entered) return null;
    const masterKey = getMasterKey();
    const current = (source.secrets ?? [])
      .filter((x: any) => !x.validUntil)
      .map((x: any) => {
        try {
          return { version: x.version as number, validFrom: new Date(x.validFrom), value: aesGcmDecrypt(x.secretEncrypted, masterKey) };
        } catch {
          return null;
        }
      })
      .filter(Boolean) as { version: number; validFrom: Date; value: string }[];
    const mine = current.filter((x) => x.value === entered);
    const others = current.filter((x) => x.value !== entered);
    if (mine.length === 0 || others.length === 0) return null;
    // M-R3-1: quyết theo event MỚI NHẤT verify được bằng BẤT KỲ version hiện hành nào (provider đang ký bằng key nào
    // NGAY BÂY GIỜ), rồi dừng. Không lấy "bất kỳ event nào khớp key nhập": dán lại một key cũ còn hiện hành thì event
    // cũ ký bằng key đó sẽ "xác nhận" sai và retire key đúng. Cửa sổ = từ version hiện hành cũ nhất; chỉ hàng ACCEPTED (L-R3-2).
    const since = new Date(Math.min(...current.map((x) => x.validFrom.getTime())));
    const events = (await this.prisma.forTenant(tenantId).findRecentRawEventsForSource(source.id, since, SECRET_EVIDENCE_SAMPLE, 'ACCEPTED')).filter(
      (e: any) => e.signatureValid,
    );
    const adapter = ProviderRegistry.get(source.provider);
    const ctx = { verificationConfig: source.verificationConfig };
    for (const e of events) {
      // Thứ tự receivedAt giảm dần (repo).
      const req = { provider: source.provider, sourceKey: source.sourceKey, headers: (e.headers ?? {}) as any, rawBody: Buffer.from(e.bodyRaw), body: e.body, contentType: e.contentType ?? undefined };
      if (await adapter.verify(req, [entered], ctx)) {
        await this.tx(tenantId, (repo) => repo.retireSourceSecretVersions(source.id, others.map((x) => x.version), new Date(Date.now() + SECRET_OVERLAP_MS)));
        return 'confirmed';
      }
      if (await adapter.verify(req, others.map((x) => x.value), ctx)) return 'mismatch';
    }
    return null;
  }

  /** Secret HIỆN HÀNH (không hạn). Bản đang được thay (có `validUntil`) không tính: trùng nó vẫn phải thêm version mới, không thì hết 24 giờ là verify hỏng. */
  private currentSecrets(source: any): string[] {
    return (source.secrets ?? [])
      .filter((x: any) => !x.validUntil)
      .map((x: any) => {
        try {
          return aesGcmDecrypt(x.secretEncrypted, getMasterKey());
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  private decrypt(enc: string | null | undefined): Record<string, string> | null {
    if (!enc) return null;
    try {
      return JSON.parse(aesGcmDecrypt(enc, getMasterKey()));
    } catch {
      return null;
    }
  }

  private view(conn: any, connector: ProviderConnector): ConnectionView {
    const creds = this.decrypt(conn.credentialsEncrypted);
    const hints: Record<string, string> = {};
    if (creds) for (const f of connector.spec.fields) if (f.secret && creds[f.name]) hints[f.name] = lastN(creds[f.name]);
    return {
      sourceId: conn.sourceId,
      provider: conn.provider,
      status: conn.status,
      display: conn.display ?? null,
      ingestUrl: conn.ingestUrl,
      lastError: conn.lastError ?? null,
      fix: conn.lastFix ?? null,
      connectedAt: conn.connectedAt ?? null,
      lastCheckedAt: conn.lastCheckedAt ?? null,
      hasCredentials: !!conn.credentialsEncrypted,
      credentialHints: hints,
      manualDisconnect: connector.disconnect ? null : (connector.spec.manualDisconnect ?? null),
    };
  }

  private tx<T>(tenantId: string, fn: (repo: TenantScopedRepository) => Promise<T>): Promise<T> {
    return this.prisma.tenantTx(tenantId, (tx) => fn(this.prisma.forTenant(tenantId, tx)));
  }
}
