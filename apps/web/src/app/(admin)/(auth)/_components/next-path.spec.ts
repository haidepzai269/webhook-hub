import { safeNext } from './next-path';

/** N-2 (review AU vòng 2, ADR-122): `?next=` không được dẫn ra ngoài origin — bảng các kiểu lách. */
describe('safeNext — chặn open redirect', () => {
  const O = 'https://hub.example';
  const FB = '/dashboard/flow';
  const decoded = (q: string) => new URLSearchParams(`next=${q}`).get('next');

  it.each([
    ['//evil.com', FB],
    ['/' + String.fromCharCode(92) + 'evil.com', FB],
    ['/%09/evil.com', FB],
    ['/%0a/evil.com', FB],
    ['/%0d/evil.com', FB],
    ['/%09%5Cevil.com', FB],
    ['/%5Cevil.com', FB],
    ['%2F%2Fevil.com', FB],
    ['https://evil.com', FB],
    ['javascript:alert(1)', FB],
    ['/%2F%2Fevil.com', FB],
    ['', FB],
    ['/invite', '/invite'],
    ['/dashboard/events?x=1#h', '/dashboard/events?x=1#h'],
  ])('[AR:N-2] next=%p -> %p', (q, want) => {
    expect(safeNext(decoded(q), FB, O)).toBe(want);
  });
});
