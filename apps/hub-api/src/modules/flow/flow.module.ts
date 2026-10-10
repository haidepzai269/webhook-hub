import { Module } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '@hub/database';
import { AuthModule } from '../auth/auth.module';
import { FlowController } from './flow.controller';
import { FlowService } from './flow.service';

/**
 * Module Event Flow — tách khỏi `ApiController` để không đụng file agent đa service đang sửa.
 * `PrismaService` thuộc AppModule (không export qua module nào): mượn đúng instance đó qua
 * `ModuleRef` (strict: false), lười — tránh tạo PrismaClient/pool thứ hai trong cùng tiến trình.
 */
@Module({
  imports: [AuthModule],
  controllers: [FlowController],
  providers: [
    {
      provide: FlowService,
      inject: [ModuleRef],
      useFactory: (ref: ModuleRef) => {
        let cached: PrismaService | undefined;
        return new FlowService(() => (cached ??= ref.get(PrismaService, { strict: false })));
      },
    },
  ],
})
export class FlowModule {}
