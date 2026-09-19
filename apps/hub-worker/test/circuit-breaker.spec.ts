import { CircuitBreakerService } from '../src/circuit/circuit-breaker.service';

describe('CircuitBreakerService (§5.4 & §5.4b ADR-016)', () => {
  let service: CircuitBreakerService;
  let mockRedis: any;

  beforeEach(() => {
    mockRedis = {
      storage: new Map<string, string>(),
      get: jest.fn(async (key: string) => mockRedis.storage.get(key) || null),
      set: jest.fn(async (key: string, value: string) => {
        mockRedis.storage.set(key, value);
        return 'OK';
      }),
      del: jest.fn(async (key: string) => {
        mockRedis.storage.delete(key);
        return 1;
      }),
      incr: jest.fn(async (key: string) => {
        const current = parseInt(mockRedis.storage.get(key) || '0', 10);
        const next = current + 1;
        mockRedis.storage.set(key, String(next));
        return next;
      }),
      expire: jest.fn(async () => 1),
      publish: jest.fn(async () => 1),
    };

    service = new CircuitBreakerService(mockRedis as any);
  });

  describe('Circuit Breaker States', () => {
    it('phải mặc định ở trạng thái CLOSED khi chưa có lỗi', async () => {
      const state = await service.getState('dest_123');
      expect(state).toBe('CLOSED');
    });

    it('phải chuyển sang OPEN khi gặp 5 lỗi liên tiếp và phát cảnh báo tự động', async () => {
      const destId = 'dest_test';
      for (let i = 1; i <= 4; i++) {
        await service.recordFailure(destId);
        const state = await service.getState(destId);
        expect(state).toBe('CLOSED');
      }

      // Lần lỗi thứ 5
      await service.recordFailure(destId);
      const stateAfter5 = await service.getState(destId);
      expect(stateAfter5).toBe('OPEN');

      // Kiểm tra tự cảnh báo ADR-016
      expect(mockRedis.publish).toHaveBeenCalledWith(
        'hub:alerts',
        expect.stringContaining('CIRCUIT_BREAKER_OPEN'),
      );
    });

    it('phải reset về CLOSED và xóa bộ đếm lỗi khi thành công', async () => {
      const destId = 'dest_recover';
      await service.recordFailure(destId);
      await service.recordFailure(destId);

      await service.recordSuccess(destId);
      const state = await service.getState(destId);
      expect(state).toBe('CLOSED');
      expect(mockRedis.del).toHaveBeenCalledWith(`circuit:${destId}:failures`);
    });
  });

  describe('Outbound Throttle per destination (§5.4b)', () => {
    it('phải cho phép gửi khi rateLimitRps = 0 (không giới hạn)', async () => {
      const allowed = await service.checkThrottle('dest_unlimited', 0);
      expect(allowed).toBe(true);
      expect(mockRedis.incr).not.toHaveBeenCalled();
    });

    it('phải chặn khi số lượng request trong giây vượt quá rateLimitRps', async () => {
      const destId = 'dest_limited';
      const rps = 3;

      // 3 request đầu được phép
      expect(await service.checkThrottle(destId, rps)).toBe(true);
      expect(await service.checkThrottle(destId, rps)).toBe(true);
      expect(await service.checkThrottle(destId, rps)).toBe(true);

      // Request thứ 4 bị chặn
      expect(await service.checkThrottle(destId, rps)).toBe(false);
    });
  });
});
