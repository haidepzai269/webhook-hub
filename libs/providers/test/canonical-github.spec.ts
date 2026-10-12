import { createHmac } from 'crypto';
import { GithubAdapter } from '../src';
import { validateCanonical } from '@hub/common';
import { ctx, githubIssue, githubPing, githubPr, githubPush, githubRelease, req } from './fixtures';

/** U40–U42 — GitHub ra repo.* hoặc github.<event>. */
describe('GitHub -> catalog', () => {
  const a = new GithubAdapter();
  const norm = (event: string, body: unknown) => a.normalize(req('github', body, { 'x-github-event': event }), ctx)[0];

  it('[MS:U40] (phần a) U40 push refs/heads/main, 25 commit -> branch, tối đa 20 commit, commitCount 25, không email', () => {
    const e = norm('push', githubPush(25));
    expect(e.type).toBe('repo.push');
    expect(e.normalized).toBe(true);
    expect(e.data.branch).toBe('main');
    expect(e.data.tag).toBeNull();
    expect(e.data.commits).toHaveLength(20);
    expect(e.data.commitCount).toBe(25);
    expect(e.data.repo).toEqual({ fullName: 'kien/webhook-hub', url: 'https://github.com/kien/webhook-hub' });
    expect(e.data.actor).toEqual({ login: 'kien' });
    expect(e.subject).toBe('repo:kien/webhook-hub');
    const { raw, ...common } = e.data;
    expect(JSON.stringify(common)).not.toContain('@example.com');
    expect(JSON.stringify(raw)).toContain('@example.com');
    expect(validateCanonical(e.type, e.data)).toEqual({ ok: true });
  });

  it('[MS:U40] (phần b) U40b refs/tags/v1 -> branch null, tag v1', () => {
    const e = norm('push', githubPush(0, 'refs/tags/v1'));
    expect(e.data.branch).toBeNull();
    expect(e.data.tag).toBe('v1');
    expect(validateCanonical(e.type, e.data)).toEqual({ ok: true });
  });

  it('[MS:U41] U41 PR closed + merged -> repo.pull_request.merged; merged:false -> closed', () => {
    const m = norm('pull_request', githubPr('closed', true));
    expect(m.type).toBe('repo.pull_request.merged');
    expect(m.data).toMatchObject({
      number: 7,
      merged: true,
      state: 'closed',
      baseBranch: 'main',
      headBranch: 'feat/s14',
      author: { login: 'amelia' },
    });
    expect(validateCanonical(m.type, m.data)).toEqual({ ok: true });
    expect(norm('pull_request', githubPr('closed', false)).type).toBe('repo.pull_request.closed');
    expect(norm('pull_request', githubPr('opened', false)).type).toBe('repo.pull_request.opened');
  });

  it('issues -> repo.issue.<action>, labels là tên', () => {
    const e = norm('issues', githubIssue('opened'));
    expect(e.type).toBe('repo.issue.opened');
    expect(e.data.labels).toEqual(['bug', 'p1']);
    expect(validateCanonical(e.type, e.data)).toEqual({ ok: true });
  });

  it('[MS:U42] U42 ping, release -> github.ping, github.release.published, normalized:false', () => {
    const p = norm('ping', githubPing());
    expect(p.type).toBe('github.ping');
    expect(p.normalized).toBe(false);
    expect(Object.keys(p.data)).toEqual(['raw']);
    const r = norm('release', githubRelease());
    expect(r.type).toBe('github.release.published');
    expect(r.normalized).toBe(false);
  });
});

/** ADR-162 — GitHub "Content type: application/x-www-form-urlencoded" + ping là probe. */
describe('GitHub form-urlencoded + ping probe (ADR-162)', () => {
  const a = new GithubAdapter();
  const SECRET = 'gh-secret-adr162';
  /** Mô phỏng đúng thứ hub nhận: bytes gốc `payload=<json>`, req.body = kết quả express.urlencoded. */
  const formReq = (event: string, payload: unknown, opts: { contentType?: string | null; body?: unknown } = {}) => {
    const json = JSON.stringify(payload);
    const raw = Buffer.from(new URLSearchParams({ payload: json }).toString(), 'utf8');
    const sig = 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex');
    const contentType = opts.contentType === null ? undefined : (opts.contentType ?? 'application/x-www-form-urlencoded');
    return {
      provider: 'github' as const,
      sourceKey: 'fixture',
      headers: { 'x-github-event': event, 'x-github-delivery': 'd-162', 'x-hub-signature-256': sig },
      rawBody: raw,
      body: opts.body ?? { payload: json },
      contentType,
    };
  };

  it('form-urlencoded push -> chữ ký trên bytes gốc khớp, repo.push đủ repo.fullName, hợp lệ theo catalog', async () => {
    const r = formReq('push', githubPush(3));
    await expect(a.verify(r, [SECRET])).resolves.toBe(true);
    const e = a.normalize(r, ctx)[0];
    expect(e.type).toBe('repo.push');
    expect(e.normalized).toBe(true);
    expect(e.data.repo).toEqual({ fullName: 'kien/webhook-hub', url: 'https://github.com/kien/webhook-hub' });
    expect(e.data.branch).toBe('main');
    expect(e.data.commitCount).toBe(3);
    expect(e.subject).toBe('repo:kien/webhook-hub');
    expect(validateCanonical(e.type, e.data)).toEqual({ ok: true });
    // giống hệt bản JSON (trừ không có gì khác) — cùng hợp đồng đầu ra
    const j = a.normalize(req('github', githubPush(3), { 'x-github-event': 'push' }), ctx)[0];
    expect(e.data).toEqual(j.data);
  });

  it('replay/renormalize: giải từ rawBody (body_raw) kể cả khi body đã lưu không dùng được', () => {
    const e = a.normalize(formReq('push', githubPush(1), { body: {} }), ctx)[0];
    expect(validateCanonical(e.type, e.data)).toEqual({ ok: true });
  });

  it('thiếu content-type nhưng body có `payload` chuỗi -> vẫn giải', () => {
    const e = a.normalize(formReq('push', githubPush(1), { contentType: null }), ctx)[0];
    expect(validateCanonical(e.type, e.data)).toEqual({ ok: true });
  });

  it('content-type application/json có trường `payload` chuỗi -> KHÔNG giải (body JSON giữ nguyên)', () => {
    const body = { ...githubPing(), payload: JSON.stringify({ repository: { full_name: 'evil/other' } }) };
    const r = { ...formReq('ping', githubPing(), { contentType: 'application/json', body }), rawBody: Buffer.from(JSON.stringify(body)) };
    const e = a.normalize(r, ctx)[0];
    expect(e.subject).toBe('kien/webhook-hub');
    expect(e.data.raw).toEqual(body);
  });

  it('payload JSON hỏng -> không ném, rơi về body nguyên trạng (worker báo lỗi catalog, không crash)', () => {
    const r = { ...formReq('push', githubPush(1)), rawBody: Buffer.from('payload=%7Bhong'), body: { payload: '{hong' } };
    expect(() => a.normalize(r, ctx)).not.toThrow();
  });

  it('ping (JSON hoặc form) -> github.ping, normalized:false, probe:true (như probe confirm-webhook PayOS)', () => {
    const j = a.normalize(req('github', githubPing(), { 'x-github-event': 'ping' }), ctx)[0];
    expect(j).toMatchObject({ type: 'github.ping', normalized: false, probe: true });
    expect(Object.keys(j.data)).toEqual(['raw']);
    const f = a.normalize(formReq('ping', githubPing()), ctx)[0];
    expect(f).toMatchObject({ type: 'github.ping', normalized: false, probe: true });
    // sự kiện thường KHÔNG mang probe
    expect(a.normalize(req('github', githubPush(1), { 'x-github-event': 'push' }), ctx)[0].probe).toBeUndefined();
    expect(a.normalize(req('github', githubRelease(), { 'x-github-event': 'release' }), ctx)[0].probe).toBeUndefined();
  });

  it('khoá chống trùng dự phòng (thiếu x-github-delivery) đọc commit từ payload form', () => {
    const r = formReq('push', githubPush(1));
    const { ['x-github-delivery']: _, ...headers } = r.headers;
    const k = a.extractIdempotencyKey({ ...r, headers });
    const p = githubPush(1) as any;
    expect(k).toBe(`github:${p.head_commit?.id ?? p.after}`);
  });
});
