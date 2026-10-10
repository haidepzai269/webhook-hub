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
