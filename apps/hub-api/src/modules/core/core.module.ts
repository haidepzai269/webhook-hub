import { Global, Module } from '@nestjs/common';
import { PrismaService } from '@hub/database';
import { RedisService } from '../redis/redis.service';

/**
 * AU1: MỘT PrismaService + MỘT RedisService cho cả tiến trình, dùng được ở mọi module (AppModule, AuthModule,
 * FlowModule) — SessionGuard cần PrismaService ở mọi controller có đăng nhập. Không tạo pool thứ hai.
 */
@Global()
@Module({
  providers: [{ provide: PrismaService, useFactory: () => PrismaService.getInstance() }, RedisService],
  exports: [PrismaService, RedisService],
})
export class CoreModule {}
