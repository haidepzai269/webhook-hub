import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { ProjectScopeGuard } from '../console/project-scope.guard';
import { FlowService } from './flow.service';

/**
 * F7 (§6A, DINH-CHINH X2): phạm vi dữ liệu của route `flow` đi qua ĐÚNG `ProjectScopeGuard` của console —
 * chỗ duy nhất đọc `?projectId=` (kiểm project tồn tại, đặt `request.tenantId`). Module flow không có
 * PrismaService riêng nên bọc guard đó với PrismaService mượn từ AppModule (cùng instance, EF-3);
 * KHÔNG tự đọc query. AU3 thay ProjectScopeGuard thì chỗ này tự theo.
 */
@Injectable()
export class FlowProjectScopeGuard implements CanActivate {
  constructor(private readonly flow: FlowService) {}

  canActivate(context: ExecutionContext): Promise<boolean> {
    return new ProjectScopeGuard(this.flow.prisma).canActivate(context);
  }
}

/** Tham số tenant sau khi FlowProjectScopeGuard đã chạy (= project đang xem). */
export const FlowScope = CurrentTenant;
