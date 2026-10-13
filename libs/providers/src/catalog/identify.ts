import type { BodyFormat, CapturedSample, CatalogEntry, HandlerKind, IdentifyInput, IdentifyMatch, IdentifyResult } from './types';

/**
 * PK9 (SPEC-provider-khac §8.2, ADR-208): `identify()` — nhận diện provider từ tên, mẫu request, tên header hoặc mẫu
 * thu được. HÀM THUẦN trên dữ liệu danh mục: KHÔNG import Node API (`fs`, `crypto`, `process`, `Buffer`) — chạy ở trình
 * duyệt, nên mẫu dev dán vào (có thể chứa secret, PII) không bao giờ rời máy dev (①②③). Server (PK6 ④) gọi cùng hàm.
 *
 * - Parse LỎNG mọi khuôn F15 (json-object/array, jsonl, form kể cả `a[b]`, xml thẻ gốc, jwt, rỗng), KHÔNG dựa
 *   content-type (SNS gửi JSON với `text/plain`). Parse lỗi -> `problems`, không ném.
 * - Khớp: đủ MỌI `required` (header, body, query) mới là ứng viên; `score = (required + optional khớp) / tổng`
 *   (User-Agent tính là một mục optional). Cùng điểm thì mục khớp nhiều `required` hơn đứng trước (cụ thể hơn);
 *   cùng `group` mà cùng điểm thì cả nhóm đều có mặt — không chọn bừa.
 * - Không khớp gì: `guess` đọc bằng chứng (tiền tố header chữ ký, User-Agent, tên miền trong trường URL cấp một);
 *   header chung (`x-signature`, `authorization`…) không sinh tên. Không fuzzy.
 */
export function identify(input: IdentifyInput, catalog: readonly CatalogEntry[]): IdentifyResult {
  const problems: string[] = [];
  const req = readRequest(input, problems);
  const byId = new Map<string, IdentifyMatch & { req: number }>();
  const put = (m: IdentifyMatch & { req: number }) => {
    const prev = byId.get(m.id);
    if (!prev) byId.set(m.id, m);
    else byId.set(m.id, { ...prev, score: Math.max(prev.score, m.score), req: Math.max(prev.req, m.req), matched: [...prev.matched, ...m.matched] });
  };

  if (req) for (const e of catalog) {
    const m = matchEntry(e, req);
    if (m) put(m);
  }
  if (typeof input.name === 'string' && input.name.trim().length > 0) {
    for (const e of catalog) {
      const m = matchName(e, input.name);
      if (m) put(m);
    }
  }
  if (typeof input.headerName === 'string' && input.headerName.trim().length > 0) {
    const h = input.headerName.trim().toLowerCase();
    for (const e of catalog) {
      const inReq = e.fingerprint.headers.required.includes(h);
      if (inReq || e.fingerprint.headers.optional.includes(h)) put(base(e, inReq ? 1 : 0.5, [`header:${h}`], inReq ? 1 : 0));
    }
  }

  const matches = [...byId.values()]
    .sort((a, b) => b.score - a.score || b.req - a.req || a.id.localeCompare(b.id))
    .map(({ req: _r, ...m }) => m);
  const guess = matches.length === 0 && req ? guessName(req, input.headerName) : matches.length === 0 && input.headerName ? guessName(emptyReq([input.headerName.trim().toLowerCase()]), input.headerName) : null;
  return {
    matches,
    guess,
    shape: req && req.hasHeaders ? shapeOf(req) : null,
    bodyFormat: req ? req.format : null,
    problems,
  };
}

// ───────────────────────────── đọc request ─────────────────────────────

interface ParsedRequest {
  method: string | null;
  headers: Record<string, string>;
  hasHeaders: boolean;
  queryKeys: Set<string>;
  /** Khuôn body; null khi không có body. */
  format: BodyFormat | null;
  bodyKeys: Set<string>;
  /** Giá trị chuỗi http(s) ở trường cấp một (cho `guess`). */
  urls: string[];
}

function emptyReq(headerNames: string[] = []): ParsedRequest {
  // Review PK9 T-j: không prototype — header `constructor` / `__proto__` là header thường, không bị `in` / setter nuốt.
  const headers: Record<string, string> = Object.create(null);
  for (const h of headerNames) headers[h] = '';
  return { method: null, headers, hasHeaders: headerNames.length > 0, queryKeys: new Set(), format: null, bodyKeys: new Set(), urls: [] };
}

/**
 * Review PK9 TB-1 + R2 TB-R2-1: hai trần.
 * - `IDENTIFY_MAX_INPUT_CHARS` (1 MB = trần ingest `MAX_INGEST_PAYLOAD_BYTES`): cả mẫu dán / body thu được. `JSON.parse`
 *   chạy trên body ĐẦY ĐỦ tới trần này (V8 tuyến tính) — body JSON hợp lệ lớn (GitHub push nhiều commit, Shopify đơn nhiều dòng,
 *   Stripe invoice) vẫn đọc được khoá cấp một. Cắt TRƯỚC khi parse (bản TB-1) làm hỏng nhận diện + báo sai "JSON hỏng".
 * - `IDENTIFY_MAX_CHARS` (64 KB): chỉ cho các nhánh còn lại — XML, form, JSON lines, JWT.
 */
export const IDENTIFY_MAX_CHARS = 64 * 1024;
export const IDENTIFY_MAX_INPUT_CHARS = 1024 * 1024;
const TRUNCATED_PROBLEM = 'mẫu dài hơn 64 KB — chỉ xét 64 KB đầu';
const INPUT_TRUNCATED_PROBLEM = 'mẫu dài hơn 1 MB (trần ingest) — chỉ xét 1 MB đầu';
/** Dòng tiêu đề hỏng: báo tối đa chừng này dòng (mẫu dán lớn không sinh hàng nghìn `problems`). */
const MAX_HEADER_PROBLEMS = 5;

function clip(s: string, problems: string[], max = IDENTIFY_MAX_CHARS, problem = TRUNCATED_PROBLEM): string {
  if (s.length <= max) return s;
  if (!problems.includes(problem)) problems.push(problem);
  return s.slice(0, max);
}

function readRequest(input: IdentifyInput, problems: string[]): ParsedRequest | null {
  if (input.captured) return fromCaptured(input.captured, problems);
  if (typeof input.sample === 'string' && input.sample.trim().length > 0) {
    return fromSample(clip(input.sample, problems, IDENTIFY_MAX_INPUT_CHARS, INPUT_TRUNCATED_PROBLEM), problems);
  }
  return null;
}

function fromCaptured(c: CapturedSample, problems: string[]): ParsedRequest {
  const r = emptyReq();
  r.method = c.method ? c.method.toUpperCase() : null;
  for (const k of Object.keys(c.headers ?? {})) {
    const v = (c.headers as Record<string, string | string[]>)[k];
    const s = Array.isArray(v) ? v[0] : v;
    if (typeof s === 'string') r.headers[k.toLowerCase()] = s;
  }
  r.hasHeaders = Object.keys(r.headers).length > 0;
  r.queryKeys = queryKeys(c.query ?? '');
  applyBody(r, clip(typeof c.body === 'string' ? c.body : '', problems, IDENTIFY_MAX_INPUT_CHARS, INPUT_TRUNCATED_PROBLEM), problems);
  return r;
}

const REQUEST_LINE_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)(?:\s+HTTP\/[\d.]+)?\s*$/i;
const HEADER_LINE_RE = /^([A-Za-z0-9!#$%&'*+.^_`|~-]+):[ \t]*(.*)$/;

/** Mẫu dán: [dòng đầu] + [tiêu đề] + dòng trống + body — hoặc chỉ body. Dòng `#` ở đầu (ghi chú fixture) bị bỏ. */
function fromSample(raw: string, problems: string[]): ParsedRequest {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  let headerProblems = 0;
  let i = 0;
  while (i < lines.length && (lines[i].trim() === '' || lines[i].startsWith('#'))) i++;
  const r = emptyReq();
  const rl = REQUEST_LINE_RE.exec(lines[i] ?? '');
  if (rl) {
    r.method = rl[1].toUpperCase();
    const q = rl[2].indexOf('?');
    if (q >= 0) r.queryKeys = queryKeys(rl[2].slice(q + 1));
    i++;
  }
  if (rl || HEADER_LINE_RE.test(lines[i] ?? '')) {
    for (; i < lines.length && lines[i].trim() !== ''; i++) {
      const m = HEADER_LINE_RE.exec(lines[i]);
      if (!m) {
        if (headerProblems++ < MAX_HEADER_PROBLEMS) problems.push(`dòng tiêu đề không đọc được: "${lines[i].slice(0, 40)}"`);
        continue;
      }
      const name = m[1].toLowerCase();
      if (!(name in r.headers)) r.headers[name] = m[2].trim();
    }
    r.hasHeaders = Object.keys(r.headers).length > 0;
    i++; // dòng trống
  }
  applyBody(r, lines.slice(i).join('\n'), problems);
  return r;
}

function queryKeys(q: string): Set<string> {
  const out = new Set<string>();
  for (const part of q.replace(/^\?/, '').split('&')) {
    if (part.length === 0) continue;
    const k = decode(part.split('=')[0]);
    if (k) out.add(k);
  }
  return out;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Đoán khuôn body theo NỘI DUNG (không theo content-type). */
function applyBody(r: ParsedRequest, body: string, problems: string[]): void {
  const full = body.trim();
  if (full.length === 0) {
    // Có dòng đầu / tiêu đề mà body rỗng = body rỗng thật (Google Drive); không có gì cả = không có body.
    r.format = r.hasHeaders || r.method !== null ? 'empty' : null;
    return;
  }
  const keysOf = (o: Record<string, unknown>) => {
    for (const k of Object.keys(o)) r.bodyKeys.add(k);
    for (const v of Object.values(o)) if (typeof v === 'string' && /^https?:\/\//i.test(v)) r.urls.push(v);
  };
  if (full[0] === '{' || full[0] === '[') {
    // TB-R2-1: JSON (object / mảng) parse trên body ĐẦY ĐỦ (≤ 1 MB, đã kẹp ở readRequest).
    const v = tryJson(full);
    if (v.ok && isObj(v.value)) {
      r.format = 'json-object';
      keysOf(v.value);
      return;
    }
    if (v.ok && Array.isArray(v.value)) {
      r.format = 'json-array';
      for (const el of v.value.slice(0, 50)) if (isObj(el)) keysOf(el);
      return;
    }
    // JSON lines: chỉ 64 KB đầu; bị cắt thì bỏ dòng cuối dở dang (không coi là "JSON hỏng").
    const cut = full.length > IDENTIFY_MAX_CHARS;
    const lines = clip(full, problems).split('\n');
    if (cut && lines.length > 1) lines.pop();
    const rows = lines.filter((l) => l.trim().length > 0).map((l) => tryJson(l.trim()));
    if (rows.length > 1 && rows.every((x) => x.ok && isObj(x.value))) {
      r.format = 'jsonl';
      for (const x of rows.slice(0, 50)) if (x.ok) keysOf(x.value as Record<string, unknown>);
      return;
    }
    problems.push(
      full.length >= IDENTIFY_MAX_INPUT_CHARS
        ? 'body JSON dài hơn 1 MB — không đọc được khoá body (khoá body coi là "không biết")'
        : 'body bắt đầu như JSON nhưng không parse được (JSON, mảng JSON hay JSON lines)',
    );
    return;
  }
  // Các nhánh còn lại (XML, JWT, form): chỉ 64 KB đầu (TB-1).
  const t = clip(full, problems);
  if (t[0] === '<') {
    const root = xmlRootTag(t);
    if (root) {
      r.format = 'xml';
      r.bodyKeys.add(root);
      return;
    }
    problems.push('body bắt đầu bằng "<" nhưng không thấy thẻ gốc XML');
    return;
  }
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(t)) {
    const [h, p] = t.split('.');
    const head = tryJson(b64url(h) ?? '');
    if (head.ok && isObj(head.value) && 'alg' in head.value) {
      r.format = 'jwt';
      const payload = tryJson(b64url(p) ?? '');
      if (payload.ok && isObj(payload.value)) for (const k of Object.keys(payload.value)) r.bodyKeys.add(k);
      return;
    }
  }
  if (/^[^=&\s]+=[^\n]*$/.test(t)) {
    r.format = 'form';
    for (const part of t.split('&')) {
      const eq = part.indexOf('=');
      const k = decode(eq >= 0 ? part.slice(0, eq) : part);
      if (!k) continue;
      r.bodyKeys.add(k);
      const br = k.indexOf('[');
      if (br > 0) r.bodyKeys.add(k.slice(0, br));
      const v = eq >= 0 ? decode(part.slice(eq + 1)) : '';
      if (/^https?:\/\//i.test(v)) r.urls.push(v);
    }
    return;
  }
  problems.push('không nhận ra khuôn body (JSON, form, XML, JWT, JSON lines)');
}

const XML_TAG_AT = /<([A-Za-z_][\w:.-]*)[\s>/]/y;

/**
 * Review PK9 TB-1: tên thẻ gốc XML bằng MỘT lượt quét (`indexOf`), bỏ qua `<?…?>`, `<!--…-->`, `<!…>`. Thay ba
 * `replace` không tham lam cũ — bậc hai với `<!<!<!…` (256 KB = 28 s). Con trỏ chỉ tiến; thiếu dấu đóng thì dừng.
 */
function xmlRootTag(t: string): string | null {
  let i = 0;
  for (;;) {
    const j = t.indexOf('<', i);
    if (j < 0) return null;
    const skip = t.startsWith('<?', j) ? '?>' : t.startsWith('<!--', j) ? '-->' : t.startsWith('<!', j) ? '>' : null;
    if (skip) {
      const k = t.indexOf(skip, j + 2);
      if (k < 0) return null;
      i = k + skip.length;
      continue;
    }
    XML_TAG_AT.lastIndex = j;
    const m = XML_TAG_AT.exec(t);
    if (m) return m[1];
    i = j + 1;
  }
}

function tryJson(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}

/** base64url -> chuỗi UTF-8 bằng API trình duyệt (`atob` + `TextDecoder`), không dùng `Buffer`. */
function b64url(s: string): string | null {
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// ───────────────────────────── khớp ─────────────────────────────

function kindOf(e: CatalogEntry): HandlerKind {
  return 'native' in e.handler ? 'native' : 'unsupported' in e.handler ? 'unsupported' : 'config';
}

function base(e: CatalogEntry, score: number, matched: string[], req: number): IdentifyMatch & { req: number } {
  return { id: e.id, name: e.name, score: Math.round(score * 1000) / 1000, matched, handlerKind: kindOf(e), group: e.group, req };
}

function matchEntry(e: CatalogEntry, r: ParsedRequest): (IdentifyMatch & { req: number }) | null {
  const fp = e.fingerprint;
  if (r.method !== null && r.method !== fp.method) return null;
  const formats = Array.isArray(fp.body.format) ? fp.body.format : [fp.body.format];
  if (r.format !== null && r.format !== 'empty' && !formats.includes(r.format)) return null;
  const matched: string[] = [];
  let reqHit = 0;
  for (const h of fp.headers.required) {
    if (!(h in r.headers)) return null;
    matched.push(`header:${h}`);
    reqHit++;
  }
  for (const k of fp.body.required) {
    if (!r.bodyKeys.has(k)) return null;
    matched.push(`body:${k}`);
    reqHit++;
  }
  for (const k of fp.query.required) {
    if (!r.queryKeys.has(k)) return null;
    matched.push(`query:${k}`);
    reqHit++;
  }
  if (reqHit === 0) return null; // mục không có required nào thì khớp mọi thứ — catalog đã chặn, phòng thủ thêm
  let optHit = 0;
  for (const h of fp.headers.optional) if (h in r.headers) (matched.push(`header:${h}`), optHit++);
  for (const k of fp.body.optional) if (r.bodyKeys.has(k)) (matched.push(`body:${k}`), optHit++);
  for (const k of fp.query.optional) if (r.queryKeys.has(k)) (matched.push(`query:${k}`), optHit++);
  let uaTotal = 0;
  if (fp.userAgent) {
    uaTotal = 1;
    const ua = r.headers['user-agent'];
    if (typeof ua === 'string' && safeRegex(fp.userAgent)?.test(ua)) (matched.push('user-agent'), optHit++);
  }
  const total = fp.headers.required.length + fp.body.required.length + fp.query.required.length + fp.headers.optional.length + fp.body.optional.length + fp.query.optional.length + uaTotal;
  return base(e, (reqHit + optHit) / total, matched, reqHit);
}

function safeRegex(src: string): RegExp | null {
  try {
    return new RegExp(src);
  } catch {
    return null;
  }
}

/** Bỏ dấu tiếng Việt + chữ thường (`Ví MoMo` -> `vi momo`). */
export function foldName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
}

/**
 * Tên (①): alias khớp CHÍNH XÁC hoặc là TIỀN TỐ (≥ 3 ký tự) của cụm dán vào, sau khi bỏ dấu; xét cả cụm, cụm bỏ dấu
 * cách, và từng từ (≥ 3 ký tự) — "ví zalopay" -> zalopay. Không fuzzy (không sửa lỗi chính tả).
 */
function matchName(e: CatalogEntry, raw: string): (IdentifyMatch & { req: number }) | null {
  const q = foldName(raw);
  const tries = new Set([q, q.replace(/\s+/g, ''), ...q.split(/[\s,.;:/()-]+/).filter((t) => t.length >= 3)]);
  let best = 0;
  let hit = '';
  for (const alias of [e.id, foldName(e.name), ...e.aliases.map(foldName)]) {
    const a = alias.replace(/\s+/g, '');
    for (const t of tries) {
      const s = t === a || t === alias ? 1 : t.length >= 3 && (a.startsWith(t) || alias.startsWith(t)) ? t.length / Math.max(a.length, t.length) : 0;
      if (s > best) (best = s), (hit = alias);
    }
  }
  return best > 0 ? base(e, best, [`name:${hit}`], 0) : null;
}

// ───────────────────────────── guess + shape ─────────────────────────────

/** Header chung (nghiên cứu §3): đủ để suy khuôn, KHÔNG đủ để sinh tên. */
const GENERIC_HEADERS = new Set([
  'x-signature',
  'x-webhook-signature',
  'authorization',
  'signature',
  'x-hub-signature',
  'x-hub-signature-256',
  'webhook-signature',
  'webhook-id',
  'webhook-timestamp',
  'x-api-key',
  'x-auth-token',
  'x-callback-token',
]);
/** Từ không phải tên (header `x-callback-token` không có nghĩa là provider "Callback"). */
// Review PK9 T-f: + từ chung client/payload/timestamp/body/content/custom/access/shared (x-client-signature ≠ provider "Client").
const STOP_NAMES = new Set(['callback', 'webhook', 'webhooks', 'hook', 'hooks', 'hub', 'signature', 'request', 'event', 'events', 'auth', 'api', 'token', 'delivery', 'notification', 'secret', 'sig', 'hmac', 'x', 'client', 'payload', 'timestamp', 'body', 'content', 'custom', 'access', 'shared']);
/** UA của thư viện HTTP / công cụ — so trên chuỗi NGUYÊN (trước khi cắt hậu tố `-client`…), nên `Go-http-client` không thành "Go Http". */
const GENERIC_UA = /^(mozilla|curl|wget|go|go-http-client|axios|node-fetch|node|undici|python|python-requests|python-urllib|aiohttp|java|java-http-client|okhttp|apache-httpclient|reactornetty|restsharp|vert\.x|ruby|faraday|postmanruntime|guzzlehttp|php|dart|libwww-perl|httpie|insomnia)$/i;
/** Review PK9 T-j: tên đoán dài hơn thế này không phải tên provider (header 64 KB không sinh tên 64 KB). */
const MAX_GUESS_NAME = 40;
const SIG_HEADER_RE = /signature|hmac|(^|-)sig($|-)|-token$|webhook/;
/** Như `CANDIDATE_HEADER_RE` của GenericAdapter: tên header "trông như" mang bằng chứng xác thực. */
const CANDIDATE_HEADER_RE = /sig|token|auth|hmac|key/;

function titleCase(s: string): string {
  return s
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

function nameFromHeader(h: string): string | null {
  if (GENERIC_HEADERS.has(h) || !SIG_HEADER_RE.test(h)) return null;
  const core = h
    .replace(/^x-/, '')
    .replace(/-(webhook|signature|hmac|sig|token|hook|request|event)(-.*)?$/, '')
    .replace(/^(webhook|hook)-/, '');
  if (!core || core === h.replace(/^x-/, '') || STOP_NAMES.has(core) || STOP_NAMES.has(core.split('-')[0])) return null;
  return core.length <= MAX_GUESS_NAME ? core : null;
}

function nameFromUa(ua: string): string | null {
  const first = ua.trim().split(/[/\s(]/)[0] ?? '';
  if (GENERIC_UA.test(first)) return null;
  const core = first.replace(/[-_]?(webhooks?|hookshot|agent|bot|client|notifier|sender)$/i, '');
  if (core.length < 2 || core.length > MAX_GUESS_NAME || GENERIC_UA.test(core) || STOP_NAMES.has(core.toLowerCase())) return null;
  return core.toLowerCase();
}

function nameFromUrl(u: string): { name: string; host: string } | null {
  const m = /^https?:\/\/([^/:?#]+)/i.exec(u);
  if (!m) return null;
  const labels = m[1].toLowerCase().split('.').filter((l) => l !== 'www');
  if (labels.length < 2) return null;
  const name = labels[labels.length - 2];
  if (['example', 'localhost', 'com', 'co', 'test'].includes(name) || STOP_NAMES.has(name)) return null;
  return { name, host: m[1].toLowerCase() };
}

function guessName(r: ParsedRequest, _headerName?: string): IdentifyResult['guess'] {
  const votes: Array<{ name: string; evidence: string }> = [];
  for (const h of Object.keys(r.headers).sort()) {
    const n = nameFromHeader(h);
    if (n) votes.push({ name: n, evidence: `header ${h.slice(0, 80)}` });
  }
  const ua = r.headers['user-agent'];
  if (typeof ua === 'string') {
    const n = nameFromUa(ua);
    if (n) votes.push({ name: n, evidence: `user-agent ${ua.slice(0, 80)}` });
  }
  if (votes.length === 0) return null;
  const count = new Map<string, number>();
  for (const v of votes) count.set(v.name, (count.get(v.name) ?? 0) + 1);
  let best = votes[0].name;
  for (const v of votes) if ((count.get(v.name) ?? 0) > (count.get(best) ?? 0)) best = v.name;
  // Review PK9 T-f: tên miền trong body (vd `return_url` của chính shop) KHÔNG tự sinh tên — chỉ thêm bằng chứng khi trùng
  // tên đã đoán từ header / User-Agent.
  const evidence = votes.filter((v) => v.name === best).map((v) => v.evidence);
  for (const u of r.urls.slice(0, 5)) {
    const n = nameFromUrl(u);
    if (n && n.name === best) evidence.push(`body url ${n.host}`);
  }
  return { name: titleCase(best), evidence };
}

function shapeOf(r: ParsedRequest): NonNullable<IdentifyResult['shape']> {
  const names = Object.keys(r.headers).sort();
  const candidateHeaders = names.filter((h) => CANDIDATE_HEADER_RE.test(h) && !h.startsWith('content-'));
  const signatureHeader = candidateHeaders.find((h) => /signature/.test(h)) ?? candidateHeaders.find((h) => /sig|hmac/.test(h)) ?? candidateHeaders[0];
  let scheme: string;
  if (names.some((h) => h.startsWith('webhook-') || h.startsWith('svix-'))) scheme = 'standard-webhooks';
  else if (names.some((h) => /timestamp/.test(h)) || (signatureHeader && /(^|[,;]\s*)(t|ts)=\d+/.test(r.headers[signatureHeader] ?? ''))) scheme = 'signed-template';
  else if (candidateHeaders.length === 0) scheme = 'unverified';
  else scheme = 'hmac';
  return { scheme, ...(signatureHeader ? { signatureHeader } : {}), candidateHeaders };
}
