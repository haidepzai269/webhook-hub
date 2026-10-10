import { verifyWithFallback } from '@octokit/webhooks-methods';
import { ProviderAdapter } from './provider.interface';
import { RawWebhookRequest, NormalizedEvent, IngestResult, ProviderType, REPO_PUSH_MAX_COMMITS, parseProviderTime } from '@hub/common';
import { NormalizeContext, envelope, str } from './normalize-helpers';
import { bodyHashKey } from '@hub/crypto';

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
    // body_raw) — webhook GitHub luôn là JSON UTF-8 nên decode rawBody an toàn.
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
    const commitId = req.body?.head_commit?.id || req.body?.after;
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
    const body = req.body || {};
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
