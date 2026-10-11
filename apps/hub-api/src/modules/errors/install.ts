import { INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { requestIdMiddleware } from './request-id';
import { ServiceExceptionFilter } from './service-exception.filter';

/** DX1: một chỗ cài cho main.ts và test (UX1–UX5 dựng app thật qua hàm này — không lệch nhau). */
export function installErrorHandling(app: INestApplication): void {
  app.use(requestIdMiddleware);
  app.useGlobalFilters(new ServiceExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
}
