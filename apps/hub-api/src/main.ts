import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { installBigIntJson, logger, testOnlyConfigProblems } from '@hub/common';
import { assertAppRoleNotPrivileged, assertDatabaseLib, PrismaService } from '@hub/database';
import { corsOptions } from './cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { NestExpressApplication } from '@nestjs/platform-express';
import { authSecretProblems } from './modules/auth/auth-config';
import { installErrorHandling } from './modules/errors/install';
import { configureBodyParsers } from './body-parsers';
import { IngestService } from './modules/ingest/ingest.service';
import { installPenaltyGate } from './modules/ingest/penalty-gate';
import { installShutdown } from './shutdown';
import { parseTrustProxy } from './trust-proxy';

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

// SPEC-auth §7: JWT_SECRET (access token), CSRF_SECRET, SOCKET_TICKET_SECRET, OAUTH_COOKIE_SECRET — mỗi cái ≥ 32
// ký tự và KHÁC nhau. Thiếu -> process.exit(1) trước app.listen(): không request nào chạy với secret rỗng/đoán được
// (trước đây từng có fallback hardcode trong source công khai).
function assertAuthSecretsConfigured(): void {
  const problems = authSecretProblems(process.env);
  if (problems.length > 0) {
    logger.error({ problems }, 'FATAL: bí mật đăng nhập chưa cấu hình đúng — không thể khởi động.');
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
  assertAuthSecretsConfigured();

  // BẮT BUỘC: rawBody: true để giữ nguyên byte buffer phục vụ xác thực chữ ký HMAC
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  // AU6 (SPEC-auth §5.12.2): runtime KHÔNG được là superuser / BYPASSRLS (RLS sẽ bị bỏ qua) -> thoát.
  await assertAppRoleNotPrivileged(PrismaService.getInstance());

  // SPEC-auth §5.5: X-Forwarded-For CHỈ được tin khi đứng sau proxy thật (Render, Vercel) — TRUST_PROXY=1; compose local:
  // TRUST_PROXY=<IP của service edge> (chỉ tin nginx, không tin client gọi thẳng). Sai khuôn -> thoát (trust-proxy.ts).
  const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);
  // SPEC-auth §5.4: header bảo mật. API chỉ trả JSON; CORP cross-origin để playground của web (khác origin)
  // vẫn gọi /hooks/* được.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cookieParser());
  // DX1 (SPEC-dev-experience §2): x-request-id + khuôn lỗi {error, message, fix, docsUrl, requestId} cho /v1/p/* và /api/v1/*.
  installErrorHandling(app);

  // Kích hoạt CORS cho Dashboard và Demo Shop
  app.enableCors(corsOptions()); // MS-P2-6: không '*' kèm credentials

  // D3 (ADR-177): gate hộp phạt NGAY TRƯỚC body parser — IP/cặp đang bị phạt nhận 429 + Connection: close, Node không đọc
  // body (tới 1MB). Chỉ kiểm; chấm điểm vẫn ở ingest. Cùng instance PenaltyBox với IngestService (DI).
  installPenaltyGate(app);

  // ADR-162: body parser theo route (/hooks/* 1MB, còn lại 100KB), giữ rawBody. Đặt SAU helmet/requestId/CORS để lỗi
  // 400/413 của parser vẫn mang header CORS + bảo mật.
  configureBodyParsers(app);

  const port = process.env.PORT || 4000;
  // EG1 (ADR-175): HOST chỉ đặt khi nginx đứng trước trong cùng container (hub-all, EDGE_NGINX=1) -> 127.0.0.1, không ai
  // ngoài nginx gọi thẳng được. Không đặt -> nghe mọi interface như trước.
  const host = process.env.HOST?.trim();
  if (host) await app.listen(port, host);
  else await app.listen(port);
  logger.info(`🚀 Webhook Hub API đang chạy trên ${host ? `${host}:` : 'cổng '}${port}`);

  // Review CB6 (Thấp 3, ADR-171): SIGTERM/SIGINT -> ghi nốt bộ đếm bản trùng (trần trong SHUTDOWN_TIMEOUT_MS) rồi thoát.
  const ingest = app.get(IngestService);
  installShutdown(() => ingest.duplicates.close());
}

bootstrap().catch((err) => {
  logger.error({ err }, 'Lỗi khởi động Hub API');
  process.exit(1);
});
