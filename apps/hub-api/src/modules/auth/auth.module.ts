import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionGuard } from './session.guard';
import { SocketTicketService } from './socket-ticket.service';
import { AUTH_CONFIG, loadAuthConfig } from './auth-config';
import { AuthRateLimiter } from './rate-limit';
import { RedisService } from '../redis/redis.service';

/**
 * SPEC-auth AU1. JwtModule KHÔNG có secret mặc định: mỗi lần ký/verify truyền secret + thuật toán + iss/aud
 * tường minh (tokens.ts) — access token, vé socket dùng khoá KHÁC nhau. Bí mật kiểm lúc bootstrap (main.ts).
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    { provide: AUTH_CONFIG, useFactory: () => loadAuthConfig() },
    { provide: AuthRateLimiter, inject: [RedisService], useFactory: (redis: RedisService) => new AuthRateLimiter(redis.client) },
    AuthService,
    SessionGuard,
    SocketTicketService,
  ],
  exports: [JwtModule, AUTH_CONFIG, SessionGuard, AuthService],
})
export class AuthModule {}
