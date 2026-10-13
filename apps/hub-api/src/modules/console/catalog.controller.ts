import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { CATALOG } from '@hub/providers';
import { SessionGuard } from '../auth/session.guard';
import { RequireScope } from '../service-api/require-scope.decorator';
import { ProjectScopeGuard } from './project-scope.guard';

/**
 * PK9 (SPEC-provider-khac §8.2, ADR-208): `GET /api/v1/catalog` — danh mục provider ĐÃ BUILD (không có fixture,
 * không có dữ liệu tenant). Console tải về rồi chạy `identify()` NGAY Ở TRÌNH DUYỆT (①②③): mẫu dev dán không bao giờ
 * lên server. `CATALOG` được kiểm lúc import — danh mục sai thì hub-api không khởi động.
 * Controller riêng (như SourceConnectionsController) để không đụng ApiController.
 */
@Controller('api/v1')
@UseGuards(SessionGuard, ProjectScopeGuard)
export class CatalogController {
  @Get('catalog')
  @RequireScope('read:project')
  // Review PK9 T-g: danh mục chỉ đổi khi deploy; `private` vì phản hồi đi sau SessionGuard (không cho proxy dùng chung).
  @Header('Cache-Control', 'private, max-age=300')
  catalog() {
    return { entries: CATALOG };
  }
}
