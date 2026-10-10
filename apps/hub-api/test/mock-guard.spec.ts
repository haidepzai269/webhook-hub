jest.mock('@hub/common', () => {
  const actual = jest.requireActual('@hub/common');
  return { ...actual, logger: { ...actual.logger, info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } };
});

import { logger } from '@hub/common';
import { hubApiControllers } from '../src/app.module';
import { MockController, maskToken } from '../src/modules/mock/mock.controller';

/** Review SPEC-2 #7 (ADR-054): /mock/* không tồn tại ở production; mock Telegram không log bot token. */
describe('MockController — chỉ ngoài production, không lộ token', () => {
  it('NODE_ENV=production -> không đăng ký MockController', () => {
    expect(hubApiControllers('production')).not.toContain(MockController);
    expect(hubApiControllers('production')).toHaveLength(3);
  });

  it.each(['development', 'test', undefined])('NODE_ENV=%s -> có MockController', (env) => {
    expect(hubApiControllers(env)).toContain(MockController);
  });

  it('maskToken giữ bot id, che phần bí mật', () => {
    expect(maskToken('123456:AAH-super-secret')).toBe('123456:***');
    expect(maskToken('noColonSecret')).toBe('***');
    expect(maskToken(undefined)).toBe('');
  });

  it('/mock/telegram log KHÔNG chứa token rõ', () => {
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    new MockController().mockTelegram('123456:AAH-super-secret', { chat_id: '-1', text: 'x' }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const logged = JSON.stringify((logger.info as jest.Mock).mock.calls);
    expect(logged).not.toContain('AAH-super-secret');
    expect(logged).toContain('123456:***');
  });
});
