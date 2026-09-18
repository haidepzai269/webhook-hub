import { ProviderAdapter } from './provider.interface';
import { RawWebhookRequest, NormalizedEvent, IngestResult, ProviderType } from '@hub/common';
import { timingSafeCompare } from '@hub/crypto';
import { ulid } from 'ulidx';

export class SepayAdapter implements ProviderAdapter {
  readonly provider: ProviderType = 'sepay';

  async verify(req: RawWebhookRequest, secrets: string[]): Promise<boolean> {
    const authHeader = (req.headers['authorization'] || req.headers['Authorization']) as string;
    if (!authHeader) {
      return false;
    }

    // Format: "Apikey <KEY>" hoặc "apikey <KEY>"
    const parts = authHeader.split(' ');
    let providedKey = authHeader;
    if (parts.length === 2 && parts[0].toLowerCase() === 'apikey') {
      providedKey = parts[1];
    }

    for (const secret of secrets) {
      if (timingSafeCompare(secret, providedKey)) {
        return true;
      }
    }
    return false;
  }

  extractIdempotencyKey(req: RawWebhookRequest): string {
    const id = req.body?.id || req.body?.referenceCode || ulid();
    return `sepay:${id}`;
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
    const body = req.body || {};
    const now = new Date().toISOString();
    const isTransferIn = body.transferType === 'in' || !body.transferType;
    const eventType = isTransferIn ? 'bank.transfer.received' : 'bank.transfer.sent';

    return [
      {
        id: `evt_${ulid()}`,
        tenantId: context.tenantId,
        type: eventType,
        source: 'sepay',
        sourceId: context.sourceId,
        subject: `bank:${body.accountNumber || 'account'}:${body.code || body.id}`,
        data: {
          id: body.id,
          gateway: body.gateway,
          transactionDate: body.transactionDate,
          accountNumber: body.accountNumber,
          code: body.code,
          content: body.content,
          transferType: body.transferType,
          transferAmount: Number(body.transferAmount || 0),
          accumulated: Number(body.accumulated || 0),
          referenceCode: body.referenceCode,
          description: body.description,
        },
        occurredAt: body.transactionDate || now,
        receivedAt: now,
        correlationId: context.correlationId,
        rawEventId: context.rawEventId,
        origin: 'webhook',
      },
    ];
  }

  buildAck(result: IngestResult): { status: number; body: unknown } {
    if (result.isDuplicate) {
      return { status: 200, body: { success: true, message: 'Duplicate transaction skipped' } };
    }
    if (!result.accepted) {
      return { status: result.status, body: { success: false, message: result.message } };
    }
    return { status: 200, body: { success: true } };
  }
}
