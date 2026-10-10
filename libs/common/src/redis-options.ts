/**
 * MS-P2-3 (ADR-090): cấu hình ioredis "fail nhanh" cho MỌI client nằm trên đường request/delivery.
 * BB-2: Redis chỉ là đường tắt, được phép sai — chết thì hệ thống phải chậm ÍT, không treo.
 *
 * - `enableOfflineQueue: false`: chưa kết nối thì lệnh bị từ chối NGAY (không xếp hàng chờ reconnect — nguyên nhân
 *   8–18s/request khi Redis chết).
 * - `commandTimeout`: lệnh đã gửi mà không có trả lời (mạng treo) -> lỗi sau `REDIS_COMMAND_TIMEOUT_MS` (mặc định 300).
 * - `maxRetriesPerRequest: 0`: không gửi lại lệnh sau lỗi kết nối — caller đã fail-open.
 * - Kết nối lại chạy nền (retryStrategy), lệnh mới chạy lại bình thường khi Redis sống lại.
 * Không dùng cho client SUBSCRIBE (cần xếp hàng `subscribe` tới khi kết nối).
 */
export function fastFailRedisOptions(env: NodeJS.ProcessEnv = process.env) {
  const n = Number(env.REDIS_COMMAND_TIMEOUT_MS);
  const commandTimeout = Number.isFinite(n) && n >= 50 && n <= 5000 ? n : 300;
  return {
    lazyConnect: true,
    enableOfflineQueue: false,
    commandTimeout,
    connectTimeout: 2000,
    maxRetriesPerRequest: 0,
    enableReadyCheck: true,
    retryStrategy: (times: number) => Math.min(times * 200, 2000),
  };
}
