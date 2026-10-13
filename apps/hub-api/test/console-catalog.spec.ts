import 'reflect-metadata';
import { GUARDS_METADATA, HEADERS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { CATALOG } from '@hub/providers';
import { CatalogController } from '../src/modules/console/catalog.controller';
import { hubApiControllers } from '../src/app.module';
import { REQUIRE_SCOPE_KEY } from '../src/modules/service-api/require-scope.decorator';
import { SessionGuard } from '../src/modules/auth/session.guard';
import { ProjectScopeGuard } from '../src/modules/console/project-scope.guard';

/** PK9 (SPEC-provider-khac §8.2, ADR-208): `GET /api/v1/catalog` trả danh mục đã build, không fixture. */
describe('PK9: GET /api/v1/catalog', () => {
  it('đăng ký ở hub-api, sau SessionGuard + ProjectScopeGuard, scope read:project', () => {
    expect(hubApiControllers('production')).toContain(CatalogController);
    expect(Reflect.getMetadata(PATH_METADATA, CatalogController)).toBe('api/v1');
    expect(Reflect.getMetadata(PATH_METADATA, CatalogController.prototype.catalog)).toBe('catalog');
    expect(Reflect.getMetadata(GUARDS_METADATA, CatalogController)).toEqual([SessionGuard, ProjectScopeGuard]);
    expect(Reflect.getMetadata(REQUIRE_SCOPE_KEY, CatalogController.prototype.catalog)).toBe('read:project');
  });

  it('trả đúng CATALOG đã kiểm lúc khởi động; không có fixture / chuỗi .http trong phản hồi', () => {
    const body = new CatalogController().catalog();
    expect(body.entries).toBe(CATALOG);
    expect(body.entries.length).toBeGreaterThan(0);
    const json = JSON.stringify(body);
    expect(json).not.toContain('# origin:');
    expect(json).not.toContain('fixtures');
  });
  it('review PK9 T-g: Cache-Control: private, max-age=300 (dữ liệu chỉ đổi khi deploy; private vì sau SessionGuard)', () => {
    expect(Reflect.getMetadata(HEADERS_METADATA, CatalogController.prototype.catalog)).toEqual([{ name: 'Cache-Control', value: 'private, max-age=300' }]);
  });
});
