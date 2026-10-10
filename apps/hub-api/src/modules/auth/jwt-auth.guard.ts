import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

/**
 * Payload JWT — hệ thống chỉ có MỘT admin user (ARCHITECTURE.md §7.4, đã cắt
 * refresh token rotation). `tenantId` được cấp phát ngay tại lúc đăng nhập
 * (AuthService, hằng DEFAULT_TENANT_ID) — KHÔNG bao giờ lấy tenantId từ client.
 */
export interface JwtPayload {
  sub: string;
  tenantId: string;
  iat?: number;
  exp?: number;
}

export type RequestWithTenant = Request & { tenantId?: string; user?: JwtPayload };

/**
 * Guard xác thực JWT thủ công (không dùng passport — đủ cho một admin user
 * duy nhất). Verify token trong header `Authorization: Bearer <token>` bằng
 * `JwtService.verify()`, rồi gắn `request.tenantId` / `request.user` từ
 * payload ĐÃ VERIFY — thay cho việc tin header `x-tenant-id` do client tự gửi.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithTenant>();
    const authHeader = request.headers['authorization'];

    if (!authHeader || Array.isArray(authHeader) || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Thiếu hoặc sai định dạng header Authorization: Bearer <token>');
    }

    const token = authHeader.slice('Bearer '.length).trim();
    if (!token) {
      throw new UnauthorizedException('Thiếu JWT token');
    }

    let payload: JwtPayload;
    try {
      payload = this.jwtService.verify<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Token JWT không hợp lệ hoặc đã hết hạn');
    }

    if (!payload?.tenantId) {
      throw new UnauthorizedException('Token JWT thiếu tenantId');
    }

    // Gắn tenantId đã được verify (KHÔNG phải header client tự gửi) để controller dùng.
    request.tenantId = payload.tenantId;
    request.user = payload;

    return true;
  }
}
