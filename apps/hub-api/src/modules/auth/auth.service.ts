import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { DEFAULT_TENANT_ID } from '@hub/database';
import { logger } from '@hub/common';
import { JwtPayload } from './jwt-auth.guard';

export interface LoginResponse {
  accessToken: string;
  tokenType: 'Bearer';
}

/**
 * Một admin user duy nhất (ARCHITECTURE.md §7.4) — không có bảng `users`, không
 * đăng ký, không refresh token rotation. Danh tính admin sống trong biến môi
 * trường `ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH` (bcrypt hash), không phải DB.
 */
@Injectable()
export class AuthService {
  constructor(private readonly jwtService: JwtService) {}

  async login(username: string, password: string): Promise<LoginResponse> {
    const adminUsername = process.env.ADMIN_USERNAME;
    const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH;

    if (!adminUsername || !adminPasswordHash) {
      logger.error('ADMIN_USERNAME hoặc ADMIN_PASSWORD_HASH chưa được cấu hình — không thể đăng nhập');
      throw new UnauthorizedException('Tài khoản admin chưa được cấu hình trên máy chủ');
    }

    // `.env` bị docker-compose nội suy biến (interpolation): dấu `$` trong hash bcrypt
    // phải escape thành `$$` trong file .env (xem .env.example), và docker-compose tự
    // collapse `$$` -> `$` khi bơm vào container. Nhưng nếu tiến trình chạy KHÔNG qua
    // docker-compose (vd. `ts-node` trực tiếp đọc .env bằng dotenv), việc collapse đó
    // không xảy ra và biến vẫn giữ nguyên `$$`. Chuẩn hoá về dạng hash bcrypt thật
    // (`$2b$...`) ở đây để hoạt động đúng trong CẢ hai trường hợp — collapse `$$` -> `$`
    // là vô hại với hash đã đúng vì bcrypt không bao giờ có 2 dấu `$` liền nhau.
    const normalizedHash = adminPasswordHash.replace(/\$\$/g, '$');

    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      throw new UnauthorizedException('Thiếu username hoặc password');
    }

    // Username không phải bí mật (không cần so sánh hằng thời gian); password thì có —
    // bcrypt.compare() tự đảm bảo so sánh hash an toàn.
    if (username !== adminUsername) {
      throw new UnauthorizedException('Sai tên đăng nhập hoặc mật khẩu');
    }

    const passwordMatches = await bcrypt.compare(password, normalizedHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Sai tên đăng nhập hoặc mật khẩu');
    }

    const payload: JwtPayload = { sub: 'admin', tenantId: DEFAULT_TENANT_ID };
    const accessToken = await this.jwtService.signAsync(payload);

    return { accessToken, tokenType: 'Bearer' };
  }
}
