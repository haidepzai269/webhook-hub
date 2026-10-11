import { ConnectorError } from '../provider.interface';

/** KN2: lời gọi API provider của connector — timeout cứng, không retry ngầm, không log header (credentials nằm ở đó). */
export async function connectorFetch(url: string, init: RequestInit, timeoutMs = 20_000): Promise<{ status: number; json: any }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const timeout = (e as { name?: string })?.name === 'TimeoutError';
    throw new ConnectorError(
      timeout ? 'provider_timeout' : 'provider_unreachable',
      timeout ? 'Provider trả lời quá chậm (có thể đang gọi thử URL ingest). Bấm "Thử lại" sau ít phút.' : 'Không gọi được API của provider (mạng/DNS). Bấm "Thử lại" sau ít phút.',
    );
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/** Câu do provider trả (không bao giờ chứa credentials của ta) — cắt ngắn để vào `last_fix`. */
export function providerSays(v: unknown): string {
  return typeof v === 'string' && v.trim() ? ` (provider: "${v.trim().slice(0, 160)}")` : '';
}
