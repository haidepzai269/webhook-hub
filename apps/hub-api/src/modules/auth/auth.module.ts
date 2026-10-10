import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

@Module({
  imports: [
    JwtModule.register({
      // JWT_SECRET bắt buộc cấu hình qua env (docker-compose / Render) — theo đúng
      // convention của codebase (MASTER_KEY, HUB_SIGNING_SECRET) dùng process.env
      // trực tiếp thay vì ConfigService, vì @nestjs/config chỉ nạp .env SAU khi các
      // decorator @Module() tĩnh (bao gồm JwtModule.register ở đây) đã chạy.
      //
      // KHÔNG có fallback ở đây (theo đúng pattern MASTER_KEY — xem
      // libs/database/src/constants.ts). Trước đây có
      // `process.env.JWT_SECRET || 'dev-jwt-insecure-fallback-do-not-use-in-prod'`
      // ngay trong source đã commit lên git — nếu quên set JWT_SECRET khi deploy
      // thật, ai cũng đọc được secret công khai trên GitHub, tự ký JWT admin hợp lệ
      // và bypass toàn bộ JwtAuthGuard. Nếu thiếu, `secret` ở đây là `undefined` —
      // `assertJwtSecretConfigured()` trong apps/hub-api/src/main.ts sẽ
      // process.exit(1) trước app.listen() nên request thật không bao giờ chạm
      // JwtModule với secret rỗng.
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: '12h' },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard],
  // Export JwtModule + JwtAuthGuard để AppModule (nơi ApiController được khai báo
  // trực tiếp, không có module riêng) dùng được @UseGuards(JwtAuthGuard).
  exports: [JwtModule, JwtAuthGuard],
})
export class AuthModule {}
