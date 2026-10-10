import { parseEnvFile, envVerifyProblems } from '../lib/env-verify';
import * as fs from 'fs';
import * as path from 'path';

/** VF1 (SPEC-verification §4.2): .env.verify được commit → không bao giờ chứa secret thật hay đích thật. */
describe('.env.verify — chỉ giá trị giả, đích trỏ vào /mock/*', () => {
  it('parseEnvFile đọc KEY=VALUE, bỏ comment, giữ chuỗi rỗng, bỏ nháy', () => {
    expect(parseEnvFile('# c\nA=1\nB=\nC="x y"\n\n  D = z \n')).toEqual({ A: '1', B: '', C: 'x y', D: 'z' });
  });

  it('secret không mang tiền tố VERIFY_ONLY_ hoặc đích Telegram/Discord có giá trị → bị từ chối', () => {
    const problems = envVerifyProblems({
      MASTER_KEY: 'real-master-key',
      JWT_SECRET: 'VERIFY_ONLY_ok',
      TELEGRAM_BOT_TOKEN: '123:real',
      DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/x',
      ADMIN_PASSWORD_HASH: '$$2b$$10$$abc',
      ADMIN_USERNAME: 'admin',
    });
    expect(problems).toEqual([
      expect.stringContaining('MASTER_KEY'),
      expect.stringContaining('TELEGRAM_BOT_TOKEN'),
      expect.stringContaining('DISCORD_WEBHOOK_URL'),
    ]);
  });

  it('file .env.verify thật trong repo sạch', () => {
    const raw = fs.readFileSync(path.join(__dirname, '..', '..', '.env.verify'), 'utf8');
    expect(envVerifyProblems(parseEnvFile(raw))).toEqual([]);
  });
});
