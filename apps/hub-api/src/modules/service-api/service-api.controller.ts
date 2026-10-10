import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';
import { RequestWithPrincipal } from './principal';

/**
 * API cho service (SPEC §4.3B): `Authorization: Bearer hk_…`, path mang slug project. Mọi route qua
 * `ApiKeyGuard` (401 → 404 → 403); tenant lấy từ key, KHÔNG BAO GIỜ từ path hay body.
 */
@Controller('v1/p/:project')
@UseGuards(ApiKeyGuard)
export class ServiceApiController {
  /** SDK dùng để kiểm kết nối (`hub.me()`). Scope bất kỳ. */
  @Get('me')
  me(@Req() req: RequestWithPrincipal) {
    const k = req.apiKey!;
    return {
      project: { slug: k.project.slug, name: k.project.name, environment: k.project.environment },
      serviceName: k.serviceName,
      scopes: k.scopes,
    };
  }
}
