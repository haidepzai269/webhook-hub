/**
 * LH2 — điểm vào Worker `hub-hooks` (wrangler.toml). Logic ở `worker.ts`; file này chỉ nối runtime Workers.
 */
import type { Env } from './config';
import { defaultDeps, handleFetch, runReplay } from './worker';

interface ScheduledController {
  scheduledTime: number;
  cron: string;
}
interface ExecutionContext {
  waitUntil(p: Promise<unknown>): void;
}

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handleFetch(req, env, defaultDeps);
  },
  scheduled(ctl: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(
      runReplay(env, defaultDeps, ctl.scheduledTime).catch((e) =>
        defaultDeps.log('catchnet_error', { in: 'scheduled', error: String((e as Error)?.message ?? e) }),
      ),
    );
  },
};
