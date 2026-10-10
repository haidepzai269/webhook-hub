/**
 * Phiên HTTP cho kịch bản e2e (verify/scenarios): cookie jar tự quản (Node fetch không giữ cookie, và cookie
 * `__Host-` + Secure trên http://localhost cần gửi tay), tự gắn `x-csrf-token` = cookie `hub_csrf` cho method thay
 * đổi dữ liệu — đúng như web làm (SPEC-auth §9). KHÔNG import code hub.
 */
export interface Res {
  status: number;
  body: any;
  text: string;
  headers: Headers;
  setCookies: string[];
  ms: number;
}

export class HttpSession {
  readonly jar = new Map<string, string>();

  constructor(readonly base: string) {}

  cookie(name: string): string | undefined {
    return this.jar.get(name);
  }

  async req(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; csrf?: boolean; cookies?: boolean } = {}): Promise<Res> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.cookies !== false && this.jar.size > 0) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const mutating = !['GET', 'HEAD'].includes(method);
    if (mutating && opts.csrf !== false && this.jar.get('hub_csrf')) headers['x-csrf-token'] = this.jar.get('hub_csrf')!;
    const t0 = performance.now();
    const r = await fetch(this.base + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), redirect: 'manual' });
    const text = await r.text();
    const ms = performance.now() - t0;
    const setCookies = r.headers.getSetCookie?.() ?? [];
    for (const sc of setCookies) {
      const [pair, ...attrs] = sc.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*expires=Thu, 01 Jan 1970/i.test(a) || /^\s*max-age=0\b/i.test(a)) || value === '';
      if (expired) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    let body: any = undefined;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    return { status: r.status, body, text, headers: r.headers, setCookies, ms };
  }

  get(path: string, opts?: Parameters<HttpSession['req']>[2]) {
    return this.req('GET', path, opts);
  }
  post(path: string, body?: unknown, opts?: Parameters<HttpSession['req']>[2]) {
    return this.req('POST', path, { ...opts, body });
  }
}

export type Fn = () => Promise<void>;

/** Bộ chạy kịch bản tối giản: tên mang mã spec (verify:map quét `scenario('[AU:TA1] …'`). */
export function createRunner() {
  const results: { name: string; ok: boolean; ms: number; err?: string }[] = [];
  return {
    async scenario(name: string, fn: Fn) {
      const t0 = Date.now();
      try {
        await fn();
        results.push({ name, ok: true, ms: Date.now() - t0 });
        console.log(`✓ ${name} (${Date.now() - t0}ms)`);
      } catch (e) {
        results.push({ name, ok: false, ms: Date.now() - t0, err: (e as Error).message });
        console.log(`✗ ${name}: ${(e as Error).message}`);
      }
    },
    finish(): number {
      const failed = results.filter((r) => !r.ok);
      console.log(`\nkịch bản: ${results.length - failed.length} pass / ${failed.length} fail`);
      return failed.length > 0 ? 1 : 0;
    },
  };
}

export function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
