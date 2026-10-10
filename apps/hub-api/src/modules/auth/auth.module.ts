import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionGuard } from './session.guard';
import { SocketTicketService } from './socket-ticket.service';
import { MembersService } from './members.service';
import { AUTH_CONFIG, loadAuthConfig } from './auth-config';
import { AuthRateLimiter } from './rate-limit';
import { RedisService } from '../redis/redis.service';
import { createMailSender, MAIL_SENDER } from '@hub/common';

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
    // SPEC-auth §5.9: MAIL_DRIVER=log|resend|capture (capture ở production -> app thoát, test-only-config.ts)
    { provide: MAIL_SENDER, useFactory: () => createMailSender() },
    AuthService,
    SessionGuard,
    SocketTicketService,
    MembersService,
  ],
  exports: [JwtModule, AUTH_CONFIG, SessionGuard, AuthService, MembersService],
})
export class AuthModule {}
