/**
 * VF1 (SPEC-verification §4.1): mọi lệnh docker của bộ kiểm chứng đi qua ĐÂY — `docker compose -p hubv …`.
 * Không bao giờ gọi docker bằng tên container cứng (đóng H9).
 */
import { spawnSync, SpawnSyncOptions } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { envVerifyProblems, parseEnvFile } from './env-verify';

export const ROOT = path.resolve(__dirname, '..', '..');
export const PROJECT = 'hubv';
export const ENV_FILE = path.join(ROOT, '.env.verify');

/** Cổng host của hubv (cổng dev + 10000). Đổi ở đây thì đổi cả docker-compose.verify.yml. */
export const PORTS = { postgres: 15433, redis: 16379, amqp: 15673, rabbitUi: 25672, api: 14000, shop: 14001, sink: 14100 } as const;

export function loadVerifyEnv(): Record<string, string> {
  const env = parseEnvFile(fs.readFileSync(ENV_FILE, 'utf8'));
  const problems = envVerifyProblems(env);
  if (problems.length > 0) {
    throw new Error(`.env.verify không an toàn:\n  - ${problems.join('\n  - ')}`);
  }
  return env;
}

export function composeBaseArgs(): string[] {
  const args = ['compose', '-p', PROJECT, '-f', 'docker-compose.yml', '-f', 'docker-compose.verify.yml', '--env-file', '.env.verify'];
  if (process.env.VERIFY_WITH_METRICS === '1') args.push('--profile', 'metrics');
  if (process.env.VERIFY_WITH_WEB === '1') args.push('--profile', 'web');
  return args;
}

/**
 * Env cho tiến trình docker: XOÁ mọi biến mà .env.verify định nghĩa. Compose ưu tiên biến shell hơn --env-file,
 * nên một `MASTER_KEY`/`TELEGRAM_BOT_TOKEN` thật lỡ export trong shell sẽ lọt vào hubv nếu không xoá.
 */
export function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(loadVerifyEnv())) delete env[key];
  delete env.COMPOSE_PROJECT_NAME;
  delete env.COMPOSE_FILE;
  return env;
}

export function compose(args: string[], opts: SpawnSyncOptions = {}): number {
  const full = [...composeBaseArgs(), ...args];
  console.log(`$ docker ${full.join(' ')}`);
  const r = spawnSync('docker', full, { cwd: ROOT, stdio: 'inherit', env: childEnv(), ...opts });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

export function composeOutput(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('docker', [...composeBaseArgs(), ...args], { cwd: ROOT, env: childEnv(), encoding: 'utf8' });
  if (r.error) throw r.error;
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Chuỗi kết nối từ host vào hubv (dùng cho verify:db). Không phải secret: role mặc định của image postgres local. */
export function hostUrls() {
  return {
    DATABASE_URL: `postgresql://hub_user:hub_password@localhost:${PORTS.postgres}/webhook_hub?schema=hub`,
    DIRECT_URL: `postgresql://hub_user:hub_password@localhost:${PORTS.postgres}/webhook_hub?schema=hub`,
    REDIS_URL: `redis://localhost:${PORTS.redis}`,
    RABBITMQ_URL: `amqp://hub_admin:hub_secret@localhost:${PORTS.amqp}`,
    HUB_API_URL: `http://localhost:${PORTS.api}`,
  };
}
