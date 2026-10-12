import { verifyWithFallback } from '@octokit/webhooks-methods';
import { ProviderAdapter } from './provider.interface';
import { RawWebhookRequest, NormalizedEvent, IngestResult, ProviderType, REPO_PUSH_MAX_COMMITS, parseProviderTime } from '@hub/common';
import { NormalizeContext, envelope, str } from './normalize-helpers';
import { bodyHashKey } from '@hub/crypto';

/** ADR-162: kiểu của request "ping" — GitHub gửi khi tạo/sửa webhook (giống request kiểm tra confirm-webhook của PayOS). */
export const GITHUB_PING_EVENT = 'ping';

function headerOf(req: RawWebhookRequest, name: string): string | undefined {
  const v = req.headers[name] ?? req.headers[name.toLowerCase()];
  const s = Array.isArray(v) ? v[0] : v;
  return s === undefined || s === null ? undefined : String(s);
}

/**
 * ADR-162: webhook GitHub đặt "Content type: application/x-www-form-urlencoded" gửi `payload=<json đã URL-encode>`.
 * express.urlencoded giữ đúng bytes (rawBody) nên chữ ký vẫn khớp, nhưng `req.body` chỉ là `{ payload: "<json>" }`.
 * Giải từ `rawBody` (cũng là `raw_events.body_raw` -> renormalize/replay ra đúng như lần đầu); rawBody không có
 * `payload` thì rớt về `req.body.payload` dạng chuỗi (CHỈ khi content-type là form hoặc thiếu). Không phải form / JSON hỏng -> trả `req.body` nguyên trạng.
 */
export function githubPayload(req: RawWebhookRequest): any {
  const body = req.body;
  const ct = (req.contentType ?? headerOf(req, 'content-type') ?? '').toLowerCase();
  const isForm = ct.includes('application/x-www-form-urlencoded');
  // JSON thật có thể có trường `payload` chuỗi của riêng nó -> chỉ coi là form khi content-type là form hoặc THIẾU.
  if (!isForm && ct !== '') return body;
  const bodyPayload = body && typeof body === 'object' && typeof body.payload === 'string' ? (body.payload as string) : undefined;
  if (!isForm && bodyPayload === undefined) return body;

  let text: string | null | undefined;
  if (isForm && req.rawBody && req.rawBody.length > 0) {
    text = new URLSearchParams(Buffer.from(req.rawBody).toString('utf8')).get('payload');
  }
  text = text ?? bodyPayload;
  if (typeof text !== 'string') return body;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : body;
  } catch {
    return body;
  }
}

export class GithubAdapter implements ProviderAdapter {
  readonly provider: ProviderType = 'github';

  /**
   * Dùng SDK chính chủ GitHub (`@octokit/webhooks-methods`) thay vì tự tính HMAC:
   * cùng thuật toán (HMAC-SHA256 + `timingSafeEqual`), nhưng `verifyWithFallback`
   * xử lý đúng ngữ nghĩa xoay secret (thử `secret` đầu, rớt xuống từng secret
   * trong `additionalSecrets`) mà không cần tự viết vòng lặp thử từng secret.
   */
  async verify(req: RawWebhookRequest, secrets: string[]): Promise<boolean> {
    const rawSig = (req.headers['x-hub-signature-256'] || req.headers['X-Hub-Signature-256']) as string;
    if (!rawSig || secrets.length === 0) {
      return false;
    }

    const [primary, ...fallback] = secrets;
    // eventPayload PHẢI là chuỗi tương ứng đúng byte đã ký (CLAUDE.md: HMAC trên
    // body_raw) — webhook GitHub là JSON UTF-8 hoặc form-urlencoded (ASCII) nên decode rawBody an toàn.
    const payload = req.rawBody.toString('utf8');

    try {
      return await verifyWithFallback(primary, payload, rawSig, fallback);
    } catch {
      // Thiếu secret/signature hoặc lỗi định dạng -> coi như không hợp lệ.
      return false;
    }
  }

  extractIdempotencyKey(req: RawWebhookRequest): string {
    const delivery = (req.headers['x-github-delivery'] || req.headers['X-GitHub-Delivery']) as string;
    if (delivery) {
      return `github:${delivery}`;
    }
    // Fallback nếu thiếu header
    const payload = githubPayload(req);
    const commitId = payload?.head_commit?.id || payload?.after;
    if (commitId) {
      return `github:${commitId}`;
    }
    // S3-1: không bao giờ ngẫu nhiên — GitHub gửi lại thì body y hệt -> cùng khoá.
    return `github:${bodyHashKey(req.rawBody)}`;
  }

  extractSignature(req: RawWebhookRequest): string | null {
    const v = req.headers['x-hub-signature-256'] || req.headers['X-Hub-Signature-256'];
    const s = Array.isArray(v) ? v[0] : v;
    return s ? String(s) : null;
  }

  /**
   * S3-2 (ADR-053): `push` -> `repo.push`; `pull_request` -> `repo.pull_request.<action>` (closed +
   * merged -> `.merged`); `issues` -> `repo.issue.<action>`. Mọi event khác -> `github.<event>[.<action>]`,
   * `normalized:false`, `data = { raw }` (trước S3-2 là `repo.<event>`). Không chép email vào phần chung.
   */
  normalize(req: RawWebhookRequest, context: NormalizeContext): NormalizedEvent[] {
    const h = req.headers['x-github-event'] || req.headers['X-GitHub-Event'];
    const eventName = (Array.isArray(h) ? h[0] : h) || 'unknown';
    // ADR-162: form-urlencoded -> JSON nằm trong `payload` (giải từ rawBody).
    const body = githubPayload(req) || {};
    const repository = body.repository || {};
    const repo = { fullName: repository.full_name ?? repository.name, url: repository.html_url };
    const actor = { login: body.sender?.login };
    const subject = repo.fullName ? `repo:${repo.fullName}` : undefined;

    if (eventName === 'push') {
      const ref: string = body.ref || '';
      const commits: any[] = Array.isArray(body.commits) ? body.commits : [];
      return [
        envelope('github', context, {
          type: 'repo.push',
          subject,
          occurredAt: body.head_commit?.timestamp ? parseProviderTime(body.head_commit.timestamp) : undefined,
          normalized: true,
          data: {
            repo,
            branch: ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null,
            tag: ref.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : null,
            commits: commits.slice(0, REPO_PUSH_MAX_COMMITS).map((c) => ({
              id: c.id,
              message: c.message,
              author: str(c.author?.username) ?? str(c.author?.name),
              url: c.url,
              timestamp: c.timestamp,
            })),
            commitCount: commits.length,
            actor,
            compareUrl: str(body.compare),
            raw: body,
          },
        }),
      ];
    }

    if (eventName === 'pull_request' && body.pull_request) {
      const pr = body.pull_request;
      const merged = pr.merged === true;
      const action = body.action === 'closed' && merged ? 'merged' : body.action;
      return [
        envelope('github', context, {
          type: `repo.pull_request.${action}`,
          subject,
          normalized: true,
          data: {
            repo,
            number: pr.number ?? body.number,
            title: pr.title,
            state: pr.state,
            merged,
            url: pr.html_url,
            author: { login: pr.user?.login },
            actor,
            baseBranch: pr.base?.ref,
            headBranch: pr.head?.ref,
            raw: body,
          },
        }),
      ];
    }

    if (eventName === 'issues' && body.issue) {
      const issue = body.issue;
      return [
        envelope('github', context, {
          type: `repo.issue.${body.action}`,
          subject,
          normalized: true,
          data: {
            repo,
            number: issue.number,
            title: issue.title,
            state: issue.state,
            url: issue.html_url,
            author: { login: issue.user?.login },
            actor,
            labels: Array.isArray(issue.labels) ? issue.labels.map((l: any) => (typeof l === 'string' ? l : l?.name)) : [],
            raw: body,
          },
        }),
      ];
    }

    // ADR-162 (giống KQ1/ADR-159 của PayOS): `ping` là request kiểm tra kết nối của GitHub, không phải sự kiện repo ->
    // giữ kiểu `github.ping`, normalized:false, probe:true — lõi lưu cho console nhưng KHÔNG định tuyến (kể cả `*`).
    if (eventName === GITHUB_PING_EVENT) {
      return [
        envelope('github', context, {
          type: 'github.ping',
          subject: repo.fullName || undefined,
          data: { raw: body },
          normalized: false,
          probe: true,
        }),
      ];
    }

    return [
      envelope('github', context, {
        type: body.action ? `github.${eventName}.${body.action}` : `github.${eventName}`,
        subject: repo.fullName || undefined,
        data: { raw: body },
        normalized: false,
      }),
    ];
  }

  buildAck(result: IngestResult): { status: number; body: unknown } {
    if (result.isDuplicate) {
      return { status: 200, body: { ok: true, message: 'Duplicate delivery skipped' } };
    }
    if (!result.accepted) {
      return { status: result.status, body: { error: result.message || 'Verification failed' } };
    }
    return { status: 200, body: { ok: true, id: result.rawEventId } };
  }
}
