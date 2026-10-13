/**
 * PK9 (SPEC-provider-khac §8, ADR-208): khuôn dữ liệu của danh mục provider và của `identify()`.
 * File THUẦN kiểu — không import gì (chạy được ở trình duyệt qua alias `@hub/providers/catalog`, E28).
 */

/** Khuôn body (F15). `identify` tự đoán khuôn, không dựa content-type. */
export type BodyFormat = 'json-object' | 'json-array' | 'jsonl' | 'form' | 'xml' | 'jwt' | 'empty';
export const BODY_FORMATS: readonly BodyFormat[] = ['json-object', 'json-array', 'jsonl', 'form', 'xml', 'jwt', 'empty'];

export interface FingerprintPart {
  required: string[];
  optional: string[];
}

export interface Fingerprint {
  method: 'POST' | 'GET';
  /** Tên header viết thường. */
  headers: FingerprintPart;
  /**
   * Regex ngắn trên User-Agent (vd `^GitHub-Hookshot/`). Tính như MỘT mục optional (không bắt buộc): dev hay dán mẫu
   * không kèm User-Agent.
   */
  userAgent: string | null;
  /** `required`/`optional`: khoá cấp một (json), tên trường (form — cả `a[b]` lẫn `a`), thẻ gốc (xml), khoá payload (jwt). */
  body: FingerprintPart & { format: BodyFormat | BodyFormat[] };
  query: FingerprintPart;
}

export interface UnsupportedHandler {
  /** Một câu nêu đúng lý do (S10: provider đòi bên nhận trả lời nghiệp vụ đồng bộ). */
  reason: string;
  /** Cách đi vòng — route `POST /v1/p/:project/events` (E22). */
  workaround: string;
}

export type CatalogHandler =
  | { config: Record<string, unknown>; alternatives?: Array<{ note: string; config: Record<string, unknown> }> }
  | { native: string }
  | { unsupported: UnsupportedHandler };

export type HandlerKind = 'config' | 'native' | 'unsupported';

export interface CatalogField {
  name: string;
  label: string;
  secret: boolean;
}

/** Một mục của danh mục đã build (không có fixture). */
export interface CatalogEntry {
  id: string;
  name: string;
  aliases: string[];
  /** Nhóm va chạm (nghiên cứu §3): cùng group cùng điểm -> trả cả nhóm, không chọn bừa. */
  group: string | null;
  fingerprint: Fingerprint;
  handler: CatalogHandler;
  fields: CatalogField[];
  secretSource: 'provider' | 'hub' | 'first-request' | null;
  /** Bắt buộc khi config dùng sha1 (ADR-203: sha1 chỉ khi nhà cung cấp quy định). */
  sha1Reason?: string;
  docs: string;
  docsVersion: string | null;
  confidence: 'cao' | 'trung bình';
  /** Nguồn của mọi chi tiết trong mục (§8.4). */
  sources: string[];
}

/** Mẫu thu được ở chế độ thu (PK6) — cùng khuôn với dữ liệu dev dán. */
export interface CapturedSample {
  method?: string;
  /** Chuỗi thô sau `?`. */
  query?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: string;
}

export interface IdentifyInput {
  name?: string;
  /** Request dán vào: dòng đầu + tiêu đề + dòng trống + body; hoặc tiêu đề + body; hoặc chỉ body. */
  sample?: string;
  headerName?: string;
  captured?: CapturedSample;
}

export interface IdentifyMatch {
  id: string;
  name: string;
  score: number;
  matched: string[];
  handlerKind: HandlerKind;
  group: string | null;
}

export interface IdentifyResult {
  matches: IdentifyMatch[];
  /** Khi `matches` rỗng: tên đoán từ bằng chứng (header chữ ký, User-Agent, tên miền trong body). */
  guess: { name: string; evidence: string[] } | null;
  shape: { scheme?: string; signatureHeader?: string; candidateHeaders: string[] } | null;
  /** Khuôn body đoán được (null khi không có body). */
  bodyFormat: BodyFormat | null;
  /** Lý do khi không đọc được mẫu (không ném). */
  problems: string[];
}
