/**
 * S1: `events.seq` và `audit_logs.id` là BIGINT -> Prisma trả `bigint`, mà `JSON.stringify(1n)` NÉM lỗi.
 * Mọi response có event (dashboard, polling) sẽ 500 nếu không chuẩn hoá. Quy ước của hub: bigint ra JSON
 * là CHUỖI (cursor `nextCursor:"42"`, SPEC §4.5) — không mất chính xác trên 2^53.
 * Gọi một lần lúc khởi động tiến trình (hub-api, hub-worker). Idempotent.
 */
export function installBigIntJson(): void {
  const proto = BigInt.prototype as unknown as { toJSON?: () => string };
  if (typeof proto.toJSON === 'function') return;
  Object.defineProperty(BigInt.prototype, 'toJSON', {
    value: function (this: bigint) {
      return this.toString();
    },
    writable: true,
    configurable: true,
  });
}
