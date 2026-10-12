import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionGuard } from './session.guard';
import { SocketTicketService } from './socket-ticket.service';
import { MembersService } from './members.service';
import { GITHUB_OAUTH, GithubOAuthService, loadGithubConfig } from './github-oauth.service';
import { GOOGLE_OAUTH, GoogleOAuthService, loadGoogleConfig } from './google-oauth.service';
import { PrismaService } from '@hub/database';
import { MAIL_SENDER as MAIL } from '@hub/common';
import { AUTH_CONFIG, loadAuthConfig } from './auth-config';
import { AuthRateLimiter } from './rate-limit';
import { RedisService } from '../redis/redis.service';
import { createMailSender, MAIL_SENDER } from '@hub/common';
import { EmailFilterService, loadEmailFilterConfig } from './email-filter.service';

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
    // SPEC-auth §5.9: MAIL_DRIVER=log|resend|gmail|capture (capture ở production -> app thoát, test-only-config.ts)
    { provide: MAIL_SENDER, useFactory: () => createMailSender() },
    // ADR-180: Bloom filter email trong bộ nhớ; PUBLISH qua client lệnh sẵn có, SUBSCRIBE qua connection của gateway.
    {
      provide: EmailFilterService,
      inject: [PrismaService, RedisService],
      useFactory: (prisma: PrismaService, redis: RedisService) => new EmailFilterService(prisma, redis.client, loadEmailFilterConfig()),
    },
    AuthService,
    SessionGuard,
    SocketTicketService,
    MembersService,
    // AU5 (§5.10): GitHub OAuth App (khác secret webhook GitHub). Chưa đặt client id/secret -> /auth/github trả 503.
    { provide: GITHUB_OAUTH, useFactory: () => loadGithubConfig() },
    {
      provide: GithubOAuthService,
      inject: [AuthService, PrismaService, AUTH_CONFIG, GITHUB_OAUTH, MAIL],
      useFactory: (auth: AuthService, prisma: PrismaService, cfg: any, gh: any, mail: any) => new GithubOAuthService(auth, prisma, cfg, gh, mail),
    },
    // AU5b (ADR-127): Google OIDC — client KHÁC client gửi mail Gmail. Chưa đặt GOOGLE_OAUTH_CLIENT_ID/SECRET -> 503.
    { provide: GOOGLE_OAUTH, useFactory: () => loadGoogleConfig() },
    {
      provide: GoogleOAuthService,
      inject: [AuthService, PrismaService, AUTH_CONFIG, GOOGLE_OAUTH, MAIL],
      useFactory: (auth: AuthService, prisma: PrismaService, cfg: any, g: any, mail: any) => new GoogleOAuthService(auth, prisma, cfg, g, mail),
    },
  ],
  exports: [JwtModule, AUTH_CONFIG, SessionGuard, AuthService, MembersService],
})
export class AuthModule {}
