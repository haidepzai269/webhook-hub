/**
 * VF3 — `npm run hub-sim -- <lệnh>` (SPEC-verification §5). Bộ giả lập PHÍA PROVIDER: chỉ giữ secret của provider,
 * hub tự verify như với provider thật. Không import gì từ apps/, libs/ (§5.1).
 *
 *   list                                   liệt kê fixture
 *   show  <provider/case>                  in mô tả + body (bytes nguyên bản)
 *   sign  <provider/case> [--secret S]     in header + body đã ký (để dán vào curl)
 *   send  <provider/case> --to <url> [--secret S] [--unique X]
 *                                          ký lại bằng secret giả rồi POST; in HTTP status + body trả về.
 *                                          exit 0 khi status khớp `expect.status` của fixture.
 *   capture --raw-event <uuid> --case <tên> [--project hubv|webhook-hub]
 *                                          chép body_raw của raw_event ACCEPTED (stack LOCAL) thành fixture `real`, đã scrub
 *   scrub <file.json> [--check]            scrub body của fixture tại chỗ; --check: chỉ báo, exit 1 nếu còn số đáng ngờ
 *
 * Secret mặc định (giá trị GIẢ) đọc từ `.env.verify`: PAYOS_CHECKSUM_KEY · SEPAY_API_KEY · GITHUB_WEBHOOK_SECRET ·
 * SIM_STRIPE_SECRET · SIM_GENERIC_SECRET.
 */
import * as fs from 'fs';
import * as path from 'path';
import { bodyOf, FIXTURES_DIR, Fixture, listFixtures, loadFixture, prepare, SimProvider } from './src/fixture';
import { captureRawEvent } from './src/capture';
import { findSuspiciousNumbers, scrubText } from './src/scrub';

export const SECRET_ENV: Record<SimProvider, string> = {
  payos: 'PAYOS_CHECKSUM_KEY',
  sepay: 'SEPAY_API_KEY',
  github: 'GITHUB_WEBHOOK_SECRET',
  stripe: 'SIM_STRIPE_SECRET',
  generic: 'SIM_GENERIC_SECRET',
};

function readEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const ln of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(ln);
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}

export function defaultSecret(p: SimProvider, envFile = path.join(process.cwd(), '.env.verify')): string {
  const v = process.env[SECRET_ENV[p]] || readEnvFile(envFile)[SECRET_ENV[p]];
  if (!v) throw new Error(`thiếu secret: đặt --secret hoặc ${SECRET_ENV[p]} trong .env.verify`);
  return v;
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'list':
      for (const id of listFixtures()) {
        const f = loadFixture(id);
        console.log(`${id.padEnd(32)} ${String(f.expect.status)}  ${f.origin.padEnd(9)} ${f.description}`);
      }
      return 0;
    case 'show': {
      const f = loadFixture(args[0]);
      console.log(JSON.stringify({ ...f, bodyBase64: undefined }, null, 2));
      console.log('--- body (bytes nguyên bản) ---');
      console.log(bodyOf(f).toString('utf8'));
      return 0;
    }
    case 'sign': {
      const f = loadFixture(args[0]);
      const p = prepare(f, arg(args, '--secret') ?? defaultSecret(f.provider), { unique: arg(args, '--unique') });
      for (const [k, v] of Object.entries(p.headers)) console.log(`${k}: ${v}`);
      console.log('');
      console.log(p.body.toString('utf8'));
      return 0;
    }
    case 'send': {
      const f = loadFixture(args[0]);
      const to = arg(args, '--to');
      if (!to) throw new Error('send cần --to <url>, vd http://localhost:14000/hooks/github/src_github_main');
      const p = prepare(f, arg(args, '--secret') ?? defaultSecret(f.provider), { unique: arg(args, '--unique') });
      const res = await fetch(to, { method: p.method, headers: p.headers, body: p.body });
      const text = await res.text();
      const ok = res.status === f.expect.status;
      console.log(`${ok ? '✓' : '✗'} ${args[0]} -> ${res.status} (mong đợi ${f.expect.status}) ${text.slice(0, 300)}`);
      return ok ? 0 : 1;
    }
    case 'capture': {
      const id = arg(args, '--raw-event');
      const caseName = arg(args, '--case');
      if (!id || !caseName) throw new Error('capture --raw-event <uuid> --case <tên>');
      const f: Fixture = captureRawEvent({ rawEventId: id, caseName, project: arg(args, '--project') });
      const out = path.join(FIXTURES_DIR, f.provider, `${f.case}.json`);
      if (fs.existsSync(out)) throw new Error(`đã có ${out} — chọn --case khác`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify(f, null, 2) + '\n');
      const left = findSuspiciousNumbers(bodyOf(f).toString('utf8'));
      console.log(`đã ghi ${path.relative(process.cwd(), out)} (đã scrub${left.length ? `; CÒN ${left.length} số đáng ngờ — sửa tay` : ''})`);
      return left.length ? 1 : 0;
    }
    case 'scrub': {
      const file = args[0];
      const f = JSON.parse(fs.readFileSync(file, 'utf8')) as Fixture;
      const before = bodyOf(f).toString('utf8');
      if (args.includes('--check')) {
        const left = findSuspiciousNumbers(before);
        console.log(left.length ? `✗ còn ${left.length} số đáng ngờ` : '✓ sạch');
        return left.length ? 1 : 0;
      }
      f.bodyBase64 = Buffer.from(scrubText(before), 'utf8').toString('base64');
      fs.writeFileSync(file, JSON.stringify(f, null, 2) + '\n');
      console.log('đã scrub');
      return 0;
    }
    default:
      console.log('hub-sim: list | show | sign | send | capture | scrub  (xem đầu tools/hub-sim/cli.ts)');
      return cmd ? 2 : 0;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`hub-sim: ${e?.message ?? e}`);
      process.exit(2);
    },
  );
}
