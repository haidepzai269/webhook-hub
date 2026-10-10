import { EventEmitter } from 'events';

/**
 * R-3 (review AU, ADR-112): báo cho RealtimeGateway CÙNG tiến trình rằng quyền / phiên của một user vừa đổi
 * (logout, logout-all, thu hồi thiết bị, đặt lại / đổi mật khẩu, phát hiện dùng lại refresh token, bị xoá khỏi project).
 * Gateway kiểm lại NGAY các socket của user đó (DB, 0 lệnh Redis). Instance khác bắt kịp ở lượt quét định kỳ.
 * Dùng EventEmitter thay vì inject gateway để module auth không phụ thuộc vòng vào realtime.
 */
const bus = new EventEmitter();
bus.setMaxListeners(50);

export const ACCESS_REVOKED = 'access.revoked';

export function notifyAccessRevoked(userId: string): void {
  bus.emit(ACCESS_REVOKED, userId);
}

export function onAccessRevoked(fn: (userId: string) => void): () => void {
  bus.on(ACCESS_REVOKED, fn);
  return () => bus.off(ACCESS_REVOKED, fn);
}
