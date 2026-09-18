import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { logger } from '@hub/common';

async function bootstrap() {
  // BẮT BUỘC: rawBody: true để giữ nguyên byte buffer phục vụ xác thực chữ ký HMAC
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
  });

  // Kích hoạt CORS cho Dashboard và Demo Shop
  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  const port = process.env.PORT || 4000;
  await app.listen(port);
  logger.info(`🚀 Webhook Hub API đang chạy trên cổng ${port}`);
}

bootstrap().catch((err) => {
  logger.error({ err }, 'Lỗi khởi động Hub API');
  process.exit(1);
});
