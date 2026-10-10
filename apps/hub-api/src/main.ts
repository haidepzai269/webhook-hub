import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { installBigIntJson, logger, testOnlyConfigProblems } from '@hub/common';
import { assertDatabaseLib } from '@hub/database';
import { corsOptions } from './cors';

function assertMasterKeyConfigured(): void {
  const masterKey = process.env.MASTER_KEY;
  if (!masterKey || masterKey.length < 32) {
    logger.error(
      'FATAL: MASTER_KEY thiếu hoặc quá ngắn (yêu cầu tối thiểu 32 ký tự) — không thể khởi động. ' +
        'Không được dùng giá trị mẫu trong .env.example khi deploy thật.',
    );
    process.exit(1);
  }
}

// Cùng pattern với assertMasterKeyConfigured() ở trên. JWT_SECRET ký JWT admin cho
// toàn bộ /api/v1/* (JwtAuthGuard) — trước đây AuthModule có fallback hardcode
// ('dev-jwt-insecure-fallback-do-not-use-in-prod') ngay trong source đã commit lên
// git. Quên set JWT_SECRET khi deploy thật -> ai cũng đọc được secret công khai
// trên GitHub, tự ký JWT admin hợp lệ, bypass toàn bộ JwtAuthGuard. Chặn ở đây,
// trước app.listen(), để không có request thật nào lọt qua với secret rỗng/đoán được.
function assertJwtSecretConfigured(): void {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32) {
    logger.error(
      'FATAL: JWT_SECRET thiếu hoặc quá ngắn (yêu cầu tối thiểu 32 ký tự) — không thể khởi động. ' +
        'Không được dùng giá trị mẫu trong .env.example khi deploy thật.',
    );
    process.exit(1);
  }
}

// VF1 (SPEC-verification §4.2): secret giả `VERIFY_ONLY_…` / MAIL_DRIVER=capture ở production → thoát.
function assertNoTestOnlyConfig(): void {
  const problems = testOnlyConfigProblems(process.env);
  if (problems.length > 0) {
    logger.error({ problems }, 'FATAL: cấu hình chỉ dành cho kiểm chứng đang chạy ở production — không khởi động.');
    process.exit(1);
  }
}

async function bootstrap() {
  installBigIntJson(); // S1: events.seq / audit_logs.id là BIGINT -> JSON là chuỗi
  assertNoTestOnlyConfig();
  // S1-6: bản build lệch (dist cũ của @hub/database) phải chết ngay lúc khởi động.
  assertDatabaseLib();
  // Chặn khởi động sớm nếu MASTER_KEY chưa được cấu hình đúng — tránh mã hoá
  // secret khách hàng bằng key mặc định công khai trên GitHub (xem libs/database/src/constants.ts).
  assertMasterKeyConfigured();
  assertJwtSecretConfigured();

  // BẮT BUỘC: rawBody: true để giữ nguyên byte buffer phục vụ xác thực chữ ký HMAC
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
  });

  // Kích hoạt CORS cho Dashboard và Demo Shop
  app.enableCors(corsOptions()); // MS-P2-6: không '*' kèm credentials

  const port = process.env.PORT || 4000;
  await app.listen(port);
  logger.info(`🚀 Webhook Hub API đang chạy trên cổng ${port}`);
}

bootstrap().catch((err) => {
  logger.error({ err }, 'Lỗi khởi động Hub API');
  process.exit(1);
});
