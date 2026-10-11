/**
 * VF3 (SPEC-verification §5.2): `capture --raw-event <id>` chép `body_raw` của một dòng `raw_events` ACCEPTED thành
 * fixture `origin: "real"` — sản phẩm phụ của lần Admin test tay, không phải việc riêng.
 *
 * Công cụ dev, KHÔNG phải code của hub: đọc qua `docker compose -p <project> exec postgres psql` bằng role owner của
 * stack LOCAL (giống fixture L1 dùng owner, §4.3). Không bao giờ chạy vào Neon. Bắt buộc `scrub` trước khi ghi file.
 * Header chữ ký KHÔNG được chép (fixture luôn ký lại bằng secret giả lúc phát).
 */
import { spawnSync } from 'child_process';
import { Fixture, SignatureSpec, SimProvider } from './fixture';
import { scrubText } from './scrub';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Header an toàn để chép (không bí mật, cần để hub phân loại sự kiện). */
const KEEP_HEADERS = ['content-type', 'x-github-event'];

const DEFAULT_SIG: Record<SimProvider, SignatureSpec> = {
  payos: { scheme: 'payos-body-field', timestamped: false },
  sepay: { scheme: 'sepay-apikey', timestamped: false },
  stripe: { scheme: 'stripe', timestamped: true },
  github: { scheme: 'github', timestamped: false },
  generic: { scheme: 'generic-hmac', timestamped: false },
};

export interface CaptureOptions {
  rawEventId: string;
  caseName: string;
  /** compose project: `hubv` (mặc định) hoặc `webhook-hub` (stack dev). */
  project?: string;
  dbUser?: string;
  dbName?: string;
}

export function captureRawEvent(o: CaptureOptions): Fixture {
  if (!UUID_RE.test(o.rawEventId)) throw new Error('--raw-event phải là UUID');
  if (!/^[a-z0-9-]{1,64}$/.test(o.caseName)) throw new Error('--case: [a-z0-9-]{1,64}');
  const sql =
    `select s.provider, coalesce(s.verification_config::text,'null'), r.headers::text, encode(r.body_raw,'base64') ` +
    `from hub.raw_events r join hub.sources s on s.id = r.source_id where r.id = '${o.rawEventId}' and r.status = 'ACCEPTED'`;
  const r = spawnSync(
    'docker',
    ['compose', '-p', o.project ?? 'hubv', 'exec', '-T', 'postgres', 'psql', '-U', o.dbUser ?? 'hub_user', '-d', o.dbName ?? 'webhook_hub', '-At', '-F', '\t', '-c', sql],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`psql lỗi: ${(r.stderr || '').trim().slice(0, 300)}`);
  const line = r.stdout.trim().split('\n')[0];
  if (!line) throw new Error('không thấy raw_event ACCEPTED với id này');
  const [provider, configText, headersText, b64] = line.split('\t');
  const headersAll = JSON.parse(headersText) as Record<string, unknown>;
  const headers: Record<string, string> = {};
  for (const k of KEEP_HEADERS) if (typeof headersAll[k] === 'string') headers[k] = headersAll[k] as string;
  const p = provider as SimProvider;
  let scrubbed = scrubText(Buffer.from(b64.replace(/\s+/g, ''), 'base64').toString('utf8'));
  // PayOS: chữ ký nằm trong body -> thay bằng chỗ giữ, ký lại lúc phát.
  if (p === 'payos') scrubbed = scrubbed.replace(/("signature"\s*:\s*")[0-9a-fA-F]*(")/, '$1__SIG__$2');
  return {
    provider: p,
    case: o.caseName,
    origin: 'real',
    description: `Chép từ raw_event thật ${o.rawEventId.slice(0, 8)}…, đã scrub; ký lại bằng secret giả lúc phát`,
    method: 'POST',
    headers,
    bodyBase64: Buffer.from(scrubbed, 'utf8').toString('base64'),
    signature: DEFAULT_SIG[p] ?? { scheme: 'none', timestamped: false },
    ...(p === 'generic' && configText !== 'null' ? { sourceConfig: JSON.parse(configText) } : {}),
    expect: { status: 200, why: 'bản thật đã được hub chấp nhận (ACCEPTED)' },
  };
}
