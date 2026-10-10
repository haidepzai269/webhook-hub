import { redactHeaders, redactHeaderValue, signatureHeaderFor, SENSITIVE_HEADERS } from '../src/modules/ingest/redact-headers';

/** Review SPEC-1 #1: API key SePay không được nằm rõ trong raw_events.headers / signature_header. */
describe('redactHeaders', () => {
  it('giữ scheme, che phần còn lại: "Apikey abc" -> "Apikey ***"', () => {
    expect(redactHeaderValue('Apikey sepay_apikey_token_secret_789')).toBe('Apikey ***');
    expect(redactHeaderValue('Bearer eyJhbGciOi.xxx')).toBe('Bearer ***');
    expect(redactHeaderValue('rawtokenkhongcoscheme')).toBe('***');
    expect(redactHeaderValue('')).toBe('');
  });

  it('che authorization, cookie, x-api-key, proxy-authorization (không phân biệt hoa thường); giữ nguyên header khác', () => {
    const input = {
      authorization: 'Apikey SECRET1',
      Cookie: 'sid=SECRET2; other=SECRET3',
      'X-API-Key': 'SECRET4',
      'proxy-authorization': 'Basic SECRET5',
      'x-hub-signature-256': 'sha256=abcd',
      'content-type': 'application/json',
    };
    const out = redactHeaders(input);
    expect(out).toEqual({
      authorization: 'Apikey ***',
      Cookie: '***',
      'X-API-Key': '***',
      'proxy-authorization': 'Basic ***',
      'x-hub-signature-256': 'sha256=abcd',
      'content-type': 'application/json',
    });
    expect(JSON.stringify(out)).not.toMatch(/SECRET\d/);
    // Không đột biến đầu vào (adapter có thể còn dùng)
    expect(input.authorization).toBe('Apikey SECRET1');
  });

  it('giá trị mảng cũng bị che', () => {
    expect(redactHeaders({ 'x-api-key': ['A', 'B'] })).toEqual({ 'x-api-key': ['***', '***'] });
  });

  it('danh sách header nhạy cảm đúng 4 tên', () => {
    expect([...SENSITIVE_HEADERS].sort()).toEqual(['authorization', 'cookie', 'proxy-authorization', 'x-api-key']);
  });

  it('signatureHeaderFor: GitHub giữ chữ ký HMAC; SePay chỉ còn scheme', () => {
    expect(signatureHeaderFor(redactHeaders({ 'x-hub-signature-256': 'sha256=ab' }))).toBe('"sha256=ab"');
    const s = signatureHeaderFor(redactHeaders({ authorization: 'Apikey SECRET' }));
    expect(s).toBe('"Apikey ***"');
    expect(signatureHeaderFor({})).toBe('""');
  });
});
