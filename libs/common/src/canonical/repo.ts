/**
 * Catalog kiểu chuẩn v1 — miền REPO (GitHub) (SPEC đa service §4.14.2, ADR-053).
 * Không chép email của author vào phần chung (dữ liệu cá nhân); email vẫn có trong `raw`.
 */
import { CanonicalResult, FAIL, OK, checkExactKeys, isNullableString, isPlainObject } from './result';

export type Repo = { fullName: string; url: string };
export type Actor = { login: string };
export type RepoCommit = { id: string; message: string; author: string | null; url: string; timestamp: string };

/** Tối đa số commit chép vào phần chung; `commitCount` vẫn là tổng thật. */
export const REPO_PUSH_MAX_COMMITS = 20;

export interface RepoPush {
  repo: Repo;
  /** ref "refs/heads/x" -> branch "x" */
  branch: string | null;
  /** ref "refs/tags/x" -> tag "x" */
  tag: string | null;
  commits: RepoCommit[];
  commitCount: number;
  actor: Actor;
  compareUrl: string | null;
  raw: unknown;
}
/** `repo.pull_request.<action>`; riêng closed + merged -> `repo.pull_request.merged`. */
export interface RepoPullRequest {
  repo: Repo; number: number; title: string; state: 'open' | 'closed'; merged: boolean;
  url: string; author: Actor; actor: Actor; baseBranch: string; headBranch: string; raw: unknown;
}
/** `repo.issue.<action>` */
export interface RepoIssue {
  repo: Repo; number: number; title: string; state: 'open' | 'closed';
  url: string; author: Actor; actor: Actor; labels: string[]; raw: unknown;
}

export const REPO_PUSH_KEYS = ['repo', 'branch', 'tag', 'commits', 'commitCount', 'actor', 'compareUrl', 'raw'] as const;
export const REPO_PR_KEYS = ['repo', 'number', 'title', 'state', 'merged', 'url', 'author', 'actor', 'baseBranch', 'headBranch', 'raw'] as const;
export const REPO_ISSUE_KEYS = ['repo', 'number', 'title', 'state', 'url', 'author', 'actor', 'labels', 'raw'] as const;
const COMMIT_KEYS = ['id', 'message', 'author', 'url', 'timestamp'];

const PR_TYPE = /^repo\.pull_request\.[a-z_]+$/;
const ISSUE_TYPE = /^repo\.issue\.[a-z_]+$/;

/** Tập khoá đầy đủ của `data` cho một kiểu repo; null nếu không thuộc catalog. */
export function repoKeys(type: string): string[] | null {
  if (type === 'repo.push') return [...REPO_PUSH_KEYS];
  if (PR_TYPE.test(type)) return [...REPO_PR_KEYS];
  if (ISSUE_TYPE.test(type)) return [...REPO_ISSUE_KEYS];
  return null;
}

function checkRepo(v: unknown): CanonicalResult | null {
  if (!isPlainObject(v)) return FAIL('repo');
  const bad = checkExactKeys(v, ['fullName', 'url'], 'repo.');
  if (bad) return bad;
  if (typeof v.fullName !== 'string' || !v.fullName) return FAIL('repo.fullName');
  if (typeof v.url !== 'string') return FAIL('repo.url');
  return null;
}

function checkActor(v: unknown, field: string): CanonicalResult | null {
  if (!isPlainObject(v)) return FAIL(field);
  const bad = checkExactKeys(v, ['login'], `${field}.`);
  if (bad) return bad;
  if (typeof v.login !== 'string') return FAIL(`${field}.login`);
  return null;
}

const isPosInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0;
const isState = (v: unknown) => v === 'open' || v === 'closed';

export function validateRepo(type: string, data: unknown): CanonicalResult {
  const keys = repoKeys(type);
  if (!keys) return FAIL('type');
  if (!isPlainObject(data)) return FAIL('data');
  const d = data as Record<string, unknown>;
  const shape = checkExactKeys(d, keys);
  if (shape) return shape;
  const repo = checkRepo(d.repo);
  if (repo) return repo;
  const actor = checkActor(d.actor, 'actor');
  if (actor) return actor;
  if (d.raw === undefined) return FAIL('raw');

  if (type === 'repo.push') {
    if (!isNullableString(d.branch)) return FAIL('branch');
    if (!isNullableString(d.tag)) return FAIL('tag');
    if (!Array.isArray(d.commits) || d.commits.length > REPO_PUSH_MAX_COMMITS) return FAIL('commits');
    for (const c of d.commits) {
      if (!isPlainObject(c) || checkExactKeys(c, COMMIT_KEYS)) return FAIL('commits');
      if (typeof c.id !== 'string' || typeof c.message !== 'string' || typeof c.url !== 'string' || typeof c.timestamp !== 'string') return FAIL('commits');
      if (!isNullableString(c.author)) return FAIL('commits');
    }
    if (typeof d.commitCount !== 'number' || !Number.isInteger(d.commitCount) || d.commitCount < d.commits.length) return FAIL('commitCount');
    if (!isNullableString(d.compareUrl)) return FAIL('compareUrl');
    return OK;
  }

  if (!isPosInt(d.number)) return FAIL('number');
  if (typeof d.title !== 'string') return FAIL('title');
  if (!isState(d.state)) return FAIL('state');
  if (typeof d.url !== 'string') return FAIL('url');
  const author = checkActor(d.author, 'author');
  if (author) return author;

  if (PR_TYPE.test(type)) {
    if (typeof d.merged !== 'boolean') return FAIL('merged');
    if (typeof d.baseBranch !== 'string') return FAIL('baseBranch');
    if (typeof d.headBranch !== 'string') return FAIL('headBranch');
    return OK;
  }
  if (!Array.isArray(d.labels) || !d.labels.every((l) => typeof l === 'string')) return FAIL('labels');
  return OK;
}
