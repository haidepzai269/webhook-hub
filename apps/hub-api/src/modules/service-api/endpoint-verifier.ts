import { Inject, Injectable, Optional } from '@nestjs/common';
import * as http from 'http';
import * as https from 'https';
import { randomBytes } from 'crypto';
import { ulid } from 'ulidx';
import { createSsrfSafeAxiosConfig, swHeaders, timingSafeCompare } from '@hub/crypto';

export type VerificationOutcome = { verification: 'VERIFIED' | 'FAILED'; verificationError: string | null };

export const ENDPOINT_VERIFY_TIMEOUT_MS = 'ENDPOINT_VERIFY_TIMEOUT_MS';
const MAX_RESPONSE_BYTES = 64 * 1024;

const failed = (verificationError: string): VerificationOutcome => ({ verification: 'FAILED', verificationError });

/**
 * S6 (SPEC §4.7): challenge chứng minh service sở hữu endpoint, chạy ĐỒNG BỘ trong hub-api (tạo endpoint /
 * `/verify`). 0 lệnh Redis (X9).
 *   1. challenge = 32 byte ngẫu nhiên base64url
 *   2. POST {"type":"endpoint.verification","challenge"} ký Standard Webhooks (`webhook-id` = verify_<ulid>),
 *      qua SSRF guard (pin IP, link-local luôn chặn), KHÔNG theo redirect, tổng thời gian ≤ timeout
 *   3. 2xx + JSON `challenge` khớp (timingSafeEqual) -> VERIFIED; còn lại FAILED với lý do ngắn:
 *      timeout · http_<status> · challenge_mismatch · ssrf_blocked · invalid_json · unreachable
 */
@Injectable()
export class EndpointVerifier {
  constructor(@Optional() @Inject(ENDPOINT_VERIFY_TIMEOUT_MS) private readonly timeoutMs: number = 10_000) {}

  async challenge(url: string, signingSecret: string): Promise<VerificationOutcome> {
    const challenge = randomBytes(32).toString('base64url');
    const body = JSON.stringify({ type: 'endpoint.verification', challenge });
    let pinned;
    try {
      pinned = await createSsrfSafeAxiosConfig(url);
    } catch (e: any) {
      return failed(String(e?.message ?? '').startsWith('SSRF Guard') ? 'ssrf_blocked' : 'unreachable');
    }
    let res: { status: number; body: string };
    try {
      res = await this.post(url, body, swHeaders(signingSecret, `verify_${ulid()}`, body), pinned.httpAgent ?? pinned.httpsAgent);
    } catch (e: any) {
      return failed(e?.message === 'timeout' ? 'timeout' : 'unreachable');
    }
    if (res.status < 200 || res.status >= 300) return failed(`http_${res.status}`);
    let parsed: any;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      return failed('invalid_json');
    }
    const got = parsed && typeof parsed === 'object' ? parsed.challenge : undefined;
    return typeof got === 'string' && timingSafeCompare(got, challenge)
      ? { verification: 'VERIFIED', verificationError: null }
      : failed('challenge_mismatch');
  }

  private post(url: string, body: string, headers: Record<string, string>, agent?: http.Agent): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(
        u,
        { method: 'POST', agent, headers: { ...headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size <= MAX_RESPONSE_BYTES) chunks.push(c);
            else res.destroy();
          });
          const done = () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
          res.on('end', done);
          res.on('close', done);
        },
      );
      const timer = setTimeout(() => req.destroy(new Error('timeout')), this.timeoutMs);
      req.on('error', (e) => reject(e));
      req.on('close', () => clearTimeout(timer));
      req.end(body);
    });
  }
}
