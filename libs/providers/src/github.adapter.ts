import { verifyWithFallback } from '@octokit/webhooks-methods';
import { ProviderAdapter } from './provider.interface';
import { RawWebhookRequest, NormalizedEvent, IngestResult, ProviderType } from '@hub/common';
import { ulid } from 'ulidx';

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
    return `github:${ulid()}`;
  }

  normalize(
    req: RawWebhookRequest,
    context: {
      tenantId: string;
      sourceId: string;
      correlationId: string;
      rawEventId: string;
    },
  ): NormalizedEvent[] {
    const eventName = ((req.headers['x-github-event'] || req.headers['X-GitHub-Event']) as string) || 'unknown';
    const body = req.body || {};
    const now = new Date().toISOString();

    let normalizedType = `repo.${eventName}`;
    if (eventName === 'pull_request' && body.action) {
      normalizedType = `repo.pull_request.${body.action}`;
    } else if (eventName === 'issues' && body.action) {
      normalizedType = `repo.issue.${body.action}`;
    }

    const subject = body.repository?.full_name || body.repository?.name || 'github:repository';

    return [
      {
        id: `evt_${ulid()}`,
        tenantId: context.tenantId,
        type: normalizedType,
        source: 'github',
        sourceId: context.sourceId,
        subject,
        data: body,
        occurredAt: body.head_commit?.timestamp || now,
        receivedAt: now,
        correlationId: context.correlationId,
        rawEventId: context.rawEventId,
        origin: 'webhook',
      },
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
