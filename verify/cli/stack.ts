/**
 * VF1 (SPEC-verification §4.1, §4.4): vòng đời stack kiểm chứng `hubv`.
 *
 *   npm run verify:up      dựng (build) + chờ healthy + seed
 *   npm run verify:down    down -v: xoá volume hubv_*, KHÔNG đụng stack dev `webhook-hub`
 *   npm run verify:reset   down -v + up + seed
 *   npm run verify:seed    chờ hub-api, chạy seed (idempotent), in "thế giới" seed và kiểm đích chỉ là mock/shop
 *   npm run verify:ps      trạng thái container hubv
 */
import { compose, composeOutput, hostUrls, loadVerifyEnv } from '../lib/compose';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForApi(timeoutMs = 240_000): Promise<void> {
  const url = `${hostUrls().HUB_API_URL}/health`;
  const started = Date.now();
  let last = '';
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        console.log(`hub-api sẵn sàng (${url}) sau ${Math.round((Date.now() - started) / 1000)}s`);
        return;
      }
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = (e as Error).message;
    }
    await sleep(2000);
  }
  throw new Error(`hub-api không lên sau ${timeoutMs / 1000}s (${url}): ${last}`);
}

function psql(sql: string): string {
  const r = composeOutput(['exec', '-T', 'postgres', 'psql', '-U', 'hub_user', '-d', 'webhook_hub', '-tA', '-F', '|', '-c', sql]);
  if (r.status !== 0) throw new Error(`psql lỗi: ${r.stderr}`);
  return r.stdout.trim();
}

/** Service chạy lâu (chờ healthy). `rabbitmq-init` là one-shot: `up --wait` coi nó "exited" là lỗi dù exit 0. */
const LONG_RUNNING = ['postgres', 'redis', 'rabbitmq', 'hub-api', 'hub-worker', 'shop', 'sink'];

function up(): void {
  let code = compose(['up', '-d', '--build', '--remove-orphans']);
  if (code !== 0) process.exit(code);
  code = compose(['up', '-d', '--wait', '--no-recreate', ...LONG_RUNNING]);
  if (code !== 0) process.exit(code);
  // One-shot phải chạy xong với exit 0 (policy DLQ, ADR-052)
  for (let i = 0; i < 30; i++) {
    const r = composeOutput(['ps', '-a', '--format', '{{.Service}} {{.State}} {{.ExitCode}}', 'rabbitmq-init']);
    const line = r.stdout.trim();
    if (/exited 0$/.test(line)) return;
    if (/exited [1-9]/.test(line)) throw new Error(`rabbitmq-init lỗi: ${line}`);
    spawnSleep(1000);
  }
  throw new Error('rabbitmq-init không xong sau 30s');
}

function spawnSleep(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function seed(): Promise<void> {
  await waitForApi();
  // Seed cũng tự chạy lúc hub-api khởi động (RUN_SEED=true, ADR-066). Gọi lại là idempotent.
  const code = compose(['exec', '-T', 'hub-api', 'docker-entrypoint.sh', 'seed']);
  if (code !== 0) throw new Error(`seed exit ${code}`);

  const sources = psql('select source_key, provider, is_active from hub.sources order by source_key');
  const subs = psql(
    'select s.name, d.type, s.is_active from hub.subscriptions s join hub.destinations d on d.id = s.destination_id order by s.name',
  );
  console.log('\n=== Thế giới seed của hubv (bản đầu VF1 — mở rộng khi có S1/AU1) ===');
  console.log('Sources (source_key|provider|active):\n  ' + sources.split('\n').join('\n  '));
  console.log('Subscriptions (name|dest type|active):\n  ' + subs.split('\n').join('\n  '));

  // Đích Telegram/Discord PHẢI là mock: hub-api trong hubv không có token thật nào.
  const apiEnv = composeOutput(['exec', '-T', 'hub-api', 'sh', '-c', 'echo "tg=${TELEGRAM_BOT_TOKEN}|dc=${DISCORD_WEBHOOK_URL}"']);
  if (apiEnv.stdout.trim() !== 'tg=|dc=') {
    throw new Error(`hub-api của hubv có token/URL đích thật — dừng ngay: ${apiEnv.stdout.trim().replace(/=[^|]+/g, '=***')}`);
  }
  console.log('Đích Telegram/Discord: /mock/* (hub-api hubv không có TELEGRAM_BOT_TOKEN / DISCORD_WEBHOOK_URL) ✓');
}

async function main() {
  const cmd = process.argv[2];
  loadVerifyEnv(); // từ chối sớm nếu .env.verify chứa giá trị thật
  switch (cmd) {
    case 'up': {
      up();
      await seed();
      break;
    }
    case 'down':
      process.exit(compose(['down', '-v', '--remove-orphans']));
    case 'reset': {
      const code = compose(['down', '-v', '--remove-orphans']);
      if (code !== 0) process.exit(code);
      up();
      await seed();
      break;
    }
    case 'seed':
      await seed();
      break;
    case 'ps':
      process.exit(compose(['ps', '-a']));
    default:
      console.error('Dùng: stack.ts up|down|reset|seed|ps');
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
});
