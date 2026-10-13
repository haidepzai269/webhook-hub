import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as ts from 'typescript';
import { CATALOG, entryProblems } from '../src/catalog/catalog';
import { CATALOG_DIR, acceptanceA, acceptanceReport, readCatalogSources, renderCatalogData } from '../src/catalog/catalog-files';
import { identify } from '../src/catalog/identify';
import { BODY_FORMATS, CatalogEntry } from '../src/catalog/types';

/**
 * PK9 (SPEC-provider-khac §8, §13 bài A, ADR-208): danh mục provider là dữ liệu + `identify()` chạy ở client.
 */
const sources = readCatalogSources();
const entry = (id: string): CatalogEntry => JSON.parse(JSON.stringify(CATALOG.find((e) => e.id === id)!));

describe('[PK:T19] nghiệm thu nhận tên trên TOÀN danh mục (bài A, §13)', () => {
  it('entries/ + entries-pending/ + fixtures/ hợp lệ; catalog.data.ts khớp entries/ (quên `npm run catalog:build` -> đỏ)', () => {
    expect(sources.problems).toEqual([]);
    const built = fs.readFileSync(path.join(CATALOG_DIR, 'catalog.data.ts'), 'utf8').replace(/\r\n/g, '\n');
    expect(built).toBe(renderCatalogData(sources.entries));
    expect(CATALOG.map((e) => e.id)).toEqual(sources.entries.map((e) => e.id));
  });

  it('MỌI fixture của MỌI mục đã nạp -> chính mục đó (hoặc cùng group) đứng đầu; in bảng official / constructed', () => {
    const rows = acceptanceA(CATALOG, sources.fixtures);
    // eslint-disable-next-line no-console
    console.log(`Bài A: ${CATALOG.length} mục, ${rows.length} fixture\n${acceptanceReport(rows)}`);
    expect(rows.length).toBeGreaterThanOrEqual(CATALOG.length);
    expect(rows.filter((r) => !r.ok)).toEqual([]);
    for (const e of CATALOG) expect(rows.some((r) => r.entryId === e.id)).toBe(true);
  });

  it('nhóm Svix (resend, svix): cùng điểm -> trả CẢ nhóm, không chọn bừa', () => {
    const f = sources.fixtures.find((x) => x.entryId === 'resend')!;
    const top = identify({ sample: f.text }, CATALOG).matches.filter((m, _i, all) => m.score === all[0].score);
    expect(top.map((m) => m.id).sort()).toEqual(['resend', 'svix']);
    expect(new Set(top.map((m) => m.group))).toEqual(new Set(['svix']));
  });

  it('luật nạp: thấp / không required / native lạ / unsupported thiếu đường đi vòng / config sai / sha1 không lý do -> lỗi', () => {
    const msg = (mut: (e: any) => void, base = 'shopify') => {
      const e = entry(base);
      mut(e);
      return entryProblems(e).join(' | ');
    };
    expect(msg(() => undefined)).toBe('');
    expect(msg((e) => (e.confidence = 'thấp'))).toContain('entries-pending');
    expect(msg((e) => (e.id = 'Shopify!'))).toContain('id phải khớp');
    expect(msg((e) => (e.fingerprint.headers.required = []))).toContain('không có required');
    expect(msg((e) => (e.handler = { native: 'generic' }))).toContain('ProviderRegistry');
    expect(msg((e) => (e.handler = { native: 'shopify' }))).toContain('ProviderRegistry');
    expect(msg((e) => (e.handler = { config: { scheme: 'hmac' } }))).toContain('handler.config sai: header');
    expect(msg((e) => (e.handler = { unsupported: { reason: 'x', workaround: 'gọi /publish' } }))).toContain('POST /v1/p/:project/events');
    expect(msg((e) => (e.handler = { native: 'github', config: {} }))).toContain('ĐÚNG MỘT');
    expect(msg((e) => delete e.sha1Reason, 'vercel')).toContain('sha1Reason');
    expect(msg((e) => (e.sources = []))).toContain('sources');
    expect(msg((e) => (e.handler.alternatives = [{ note: 'x', config: { scheme: 'static-token' } }]), 'gitlab')).toContain('alternatives[0]');
  });
});

describe('[PK:T20] nhận theo tên (bỏ dấu, tiền tố ≥ 3, không fuzzy) và theo header', () => {
  const first = (name: string) => identify({ name }, CATALOG).matches[0]?.id ?? null;
  it.each([
    ['PayOS', 'payos'],
    ['payo', 'payos'],
    ['ví zalopay', 'zalopay'],
    ['Zalo Pay', 'zalopay'],
    ['cổng VNPay', 'vnpay'],
    ['Shopify', 'shopify'],
    ['Telegram Bot', 'telegram'],
    ['woo', 'woocommerce'],
  ])('%s -> %s', (name, id) => {
    expect(first(name)).toBe(id);
  });

  it('"zzz", "pa" (dưới 3 ký tự, không trùng alias), "shopfy" (sai chính tả — không fuzzy) -> rỗng', () => {
    for (const n of ['zzz', 'pa', 'shopfy']) expect(identify({ name: n }, CATALOG).matches).toEqual([]);
  });

  it('header x-shopify-hmac-sha256 -> shopify; header svix-id -> cả nhóm svix', () => {
    expect(identify({ headerName: 'X-Shopify-Hmac-Sha256' }, CATALOG).matches.map((m) => m.id)).toEqual(['shopify']);
    expect(identify({ headerName: 'svix-id' }, CATALOG).matches.map((m) => m.id).sort()).toEqual(['resend', 'svix']);
  });

  it('handlerKind theo mục: config / native / unsupported (VNPay không có nút tạo source)', () => {
    const kind = (name: string) => identify({ name }, CATALOG).matches[0].handlerKind;
    expect([kind('shopify'), kind('github'), kind('vnpay')]).toEqual(['config', 'native', 'unsupported']);
  });
});

describe('[PK:T21] provider lạ: guess kèm bằng chứng; header chung không sinh tên', () => {
  const acme = [
    'POST /hook HTTP/1.1',
    'Content-Type: application/json',
    'User-Agent: Acme-Webhooks/1.0',
    `X-Acme-Signature: sha256=${'0'.repeat(64)}`,
    '',
    '{"event":"order.paid","callback_url":"https://api.acme.io/orders/1"}',
  ].join('\n');

  it('acme: matches [], guess "Acme" với bằng chứng header + UA (+ tên miền), shape.signatureHeader = x-acme-signature', () => {
    const r = identify({ sample: acme }, CATALOG);
    expect(r.matches).toEqual([]);
    expect(r.guess?.name).toBe('Acme');
    expect(r.guess?.evidence).toEqual(expect.arrayContaining(['header x-acme-signature', 'user-agent Acme-Webhooks/1.0', 'body url api.acme.io']));
    expect(r.shape).toEqual({ scheme: 'hmac', signatureHeader: 'x-acme-signature', candidateHeaders: ['x-acme-signature'] });
  });

  it('chỉ có x-signature (header chung) -> guess null; shape vẫn suy được khuôn', () => {
    const r = identify({ sample: `POST / HTTP/1.1\nX-Signature: ${'0'.repeat(64)}\n\n{"a":1}` }, CATALOG);
    expect(r.matches).toEqual([]);
    expect(r.guess).toBeNull();
    expect(r.shape).toMatchObject({ scheme: 'hmac', signatureHeader: 'x-signature' });
    for (const h of ['authorization: Bearer x', 'x-webhook-signature: x', 'x-hub-signature: sha1=0', 'x-callback-token: x']) {
      expect(identify({ sample: `POST / HTTP/1.1\n${h}\n\n{}` }, CATALOG).guess).toBeNull();
    }
  });

  it('shape: *-timestamp -> signed-template; webhook-*/svix-* -> standard-webhooks; không header chữ ký -> unverified', () => {
    const shape = (h: string) => identify({ sample: `POST / HTTP/1.1\n${h}\n\n{"x":1}` }, CATALOG).shape?.scheme;
    expect(shape('x-foo-signature: abc\nx-foo-timestamp: 1')).toBe('signed-template');
    expect(shape('x-foo-signature: t=1700000000,v1=abc')).toBe('signed-template');
    expect(shape('webhook-id: 1\nwebhook-signature: v1,x')).toBe('standard-webhooks');
    expect(shape('content-type: application/json')).toBe('unverified');
  });
});

describe('[PK:T22] identify.ts không import Node API và chạy được ngoài Node (ngữ cảnh kiểu trình duyệt)', () => {
  const files = ['identify.ts', 'types.ts', 'index.ts'].map((f) => path.join(CATALOG_DIR, f));

  it('không import fs / crypto / process / Buffer / require; chỉ import tương đối trong catalog/', () => {
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect([f, code.match(/\b(require\(|process\.|Buffer\b|from ['"](fs|crypto|path|os|node:[a-z]+)['"])/g)]).toEqual([f, null]);
      for (const m of code.matchAll(/from ['"]([^'"]+)['"]/g)) expect([f, m[1]]).toEqual([f, expect.stringMatching(/^\.\/(identify|types)$/)]);
    }
    // identify.ts chỉ import KIỂU (bị xoá khi biên dịch) -> không kéo module nào lúc chạy.
    expect(fs.readFileSync(files[0], 'utf8')).toMatch(/^import type \{[^}]+\} from '\.\/types';/m);
  });

  it('biên dịch identify.ts rồi chạy trong vm chỉ có API trình duyệt (atob, TextDecoder) — không require/process/Buffer; kết quả = chạy trong Node', () => {
    const js = ts.transpileModule(fs.readFileSync(files[0], 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    expect(js).not.toMatch(/require\(/);
    const sandbox: Record<string, unknown> = { exports: {}, atob, TextDecoder };
    vm.createContext(sandbox);
    vm.runInContext(js, sandbox);
    expect(vm.runInContext('typeof require + typeof process + typeof Buffer', sandbox)).toBe('undefinedundefinedundefined');
    const browserIdentify = (sandbox.exports as { identify: typeof identify }).identify;
    const catalog = JSON.parse(JSON.stringify(CATALOG));
    for (const f of sources.fixtures) {
      expect(JSON.parse(JSON.stringify(browserIdentify({ sample: f.text }, catalog)))).toEqual(JSON.parse(JSON.stringify(identify({ sample: f.text }, catalog))));
    }
  });
});

describe('[PK:T23] mỗi khuôn body F15 có fixture parse được (không dựa content-type)', () => {
  it('json-object, json-array, jsonl, form, xml, jwt, empty — mỗi khuôn ≥ 1 fixture; mọi fixture parse không lỗi', () => {
    const byFormat = new Map<string, string[]>();
    for (const f of sources.fixtures) {
      const r = identify({ sample: f.text }, CATALOG);
      expect([f.file, r.problems]).toEqual([f.file, []]);
      if (r.bodyFormat) byFormat.set(r.bodyFormat, [...(byFormat.get(r.bodyFormat) ?? []), f.file]);
    }
    for (const fmt of BODY_FORMATS) expect([fmt, (byFormat.get(fmt) ?? []).length > 0]).toEqual([fmt, true]);
  });

  it('form lồng a[b] ra cả khoá đầy đủ lẫn gốc; SNS-kiểu text/plain mà body JSON vẫn là json-object; JSON hỏng -> problems, không ném', () => {
    const form = identify({ sample: 'type=subscribe&fired_at=2024-01-01&data%5Bid%5D=1&data[email]=a%40b.c' }, CATALOG);
    expect(form.bodyFormat).toBe('form');
    const fake = entry('shopify');
    fake.id = 'fake-form';
    fake.fingerprint = { ...fake.fingerprint, headers: { required: [], optional: [] }, body: { format: 'form', required: ['data', 'data[email]', 'data[id]', 'fired_at'], optional: [] } };
    expect(identify({ sample: 'type=subscribe&fired_at=2024-01-01&data%5Bid%5D=1&data[email]=a%40b.c' }, [fake]).matches.map((m) => m.id)).toEqual(['fake-form']);
    const sns = identify({ sample: 'POST / HTTP/1.1\nContent-Type: text/plain; charset=UTF-8\n\n{"Type":"Notification"}' }, CATALOG);
    expect(sns.bodyFormat).toBe('json-object');
    const broken = identify({ sample: '{"a":' }, CATALOG);
    expect(broken.bodyFormat).toBeNull();
    expect(broken.problems.length).toBe(1);
    expect(() => identify({ sample: '\u0000￿<<' }, CATALOG)).not.toThrow();
  });

  it('captured (PK6): headers + query + body -> nhận như mẫu dán; GET + query -> VNPay (unsupported)', () => {
    const r = identify(
      { captured: { method: 'GET', query: 'vnp_TmnCode=A&vnp_Amount=1&vnp_TxnRef=1&vnp_TransactionNo=1&vnp_ResponseCode=00&vnp_TransactionStatus=00&vnp_SecureHash=0', headers: {}, body: '' } },
      CATALOG,
    );
    expect(r.matches[0]).toMatchObject({ id: 'vnpay', handlerKind: 'unsupported' });
    // POST cùng query -> không khớp VNPay (fingerprint GET).
    expect(identify({ sample: 'POST /ipn?vnp_TmnCode=A&vnp_Amount=1&vnp_TxnRef=1&vnp_TransactionNo=1&vnp_ResponseCode=00&vnp_TransactionStatus=00&vnp_SecureHash=0 HTTP/1.1' }, CATALOG).matches).toEqual([]);
  });
});
