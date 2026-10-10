import * as http from 'http';
import { AddressInfo } from 'net';
import { swVerify } from '@hub/crypto';
import { EndpointVerifier } from '../src/modules/service-api/endpoint-verifier';

/**
 * S6 (SPEC §4.7): challenge chứng minh sở hữu endpoint. Server thật trên 127.0.0.1 (NODE_ENV=development
 * như hubv cho phép IP private); link-local luôn bị chặn.
 */
describe('EndpointVerifier — challenge (S6)', () => {
  const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
  const env = process.env.NODE_ENV;
  let server: http.Server;
  let base = '';
  const seen: { headers: http.IncomingHttpHeaders; raw: string; url: string }[] = [];

  beforeAll(async () => {
    (process.env as any).NODE_ENV = 'development';
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        seen.push({ headers: req.headers, raw, url: req.url! });
        const body = JSON.parse(raw);
        const mode = new URL(req.url!, 'http://x').searchParams.get('mode');
        if (mode === 'fail') return res.writeHead(500).end('x');
        if (mode === 'slow') return setTimeout(() => res.writeHead(200).end('{}'), 1500);
        if (mode === 'text') return res.writeHead(200).end('không phải json');
        if (mode === 'wrong') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ challenge: 'sai' }));
        if (mode === 'redirect') return res.writeHead(302, { location: 'http://169.254.169.254/' }).end();
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ challenge: body.challenge }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    (process.env as any).NODE_ENV = env;
    await new Promise<void>((r) => server.close(() => r()));
  });

  const v = new EndpointVerifier(500);

  it('[MS:T4] (phần b) đích trả đúng challenge -> VERIFIED; request ký Standard Webhooks, webhook-id bắt đầu verify_', async () => {
    expect(await v.challenge(`${base}/ok`, SECRET)).toEqual({ verification: 'VERIFIED', verificationError: null });
    const last = seen[seen.length - 1];
    expect(last.headers['webhook-id']).toMatch(/^verify_/);
    expect(swVerify(SECRET, last.headers as any, last.raw)).toBe(true);
    expect(JSON.parse(last.raw)).toMatchObject({ type: 'endpoint.verification' });
    expect(JSON.parse(last.raw).challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('[MS:T4] (phần c) 500 -> http_500; trả sai challenge -> challenge_mismatch; không phải JSON -> invalid_json; 302 -> http_302 (không theo redirect)', async () => {
    expect(await v.challenge(`${base}/?mode=fail`, SECRET)).toEqual({ verification: 'FAILED', verificationError: 'http_500' });
    expect(await v.challenge(`${base}/?mode=wrong`, SECRET)).toEqual({ verification: 'FAILED', verificationError: 'challenge_mismatch' });
    expect(await v.challenge(`${base}/?mode=text`, SECRET)).toEqual({ verification: 'FAILED', verificationError: 'invalid_json' });
    expect(await v.challenge(`${base}/?mode=redirect`, SECRET)).toEqual({ verification: 'FAILED', verificationError: 'http_302' });
  });

  it('S6: quá hạn -> timeout; metadata 169.254.169.254 -> ssrf_blocked (không có request nào đi ra)', async () => {
    expect(await v.challenge(`${base}/?mode=slow`, SECRET)).toEqual({ verification: 'FAILED', verificationError: 'timeout' });
    expect(await v.challenge('http://169.254.169.254/latest/meta-data', SECRET)).toEqual({ verification: 'FAILED', verificationError: 'ssrf_blocked' });
  });

  it('S6: không kết nối được -> unreachable', async () => {
    expect(await v.challenge('http://127.0.0.1:1/x', SECRET)).toEqual({ verification: 'FAILED', verificationError: 'unreachable' });
  });
});
