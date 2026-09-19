import { Controller, Get, Post, Param, Body, Query, Req, Res } from '@nestjs/common';
import { Response } from 'express';
import { PrismaService, DEFAULT_TENANT_ID, DEV_MASTER_KEY } from '@hub/database';
import { aesGcmEncrypt, aesGcmDecrypt } from '@hub/crypto';
import { ulid } from 'ulidx';

@Controller('api/v1')
export class ApiController {
  constructor(private readonly prisma: PrismaService) {}

  private getTenantRepo(req: any) {
    const tenantId = req.headers['x-tenant-id'] || DEFAULT_TENANT_ID;
    return this.prisma.forTenant(tenantId as string);
  }

  // --- Overview ---
  @Get('overview')
  async getOverview(@Req() req: any) {
    const repo = this.getTenantRepo(req);
    const [totalSources, totalDestinations, totalEvents, totalDeliveries, deadDeliveries] = await Promise.all([
      this.prisma.source.count({ where: { tenantId: repo.tenantId } }),
      this.prisma.destination.count({ where: { tenantId: repo.tenantId } }),
      this.prisma.event.count({ where: { tenantId: repo.tenantId } }),
      this.prisma.delivery.count({ where: { tenantId: repo.tenantId } }),
      this.prisma.delivery.count({ where: { tenantId: repo.tenantId, status: 'DEAD' } }),
    ]);

    return {
      totalSources,
      totalDestinations,
      totalEvents,
      totalDeliveries,
      deadDeliveries,
      successRate: totalDeliveries > 0 ? ((totalDeliveries - deadDeliveries) / totalDeliveries) * 100 : 100,
    };
  }

  // --- Sources ---
  @Get('sources')
  async listSources(@Req() req: any) {
    const repo = this.getTenantRepo(req);
    const sources = await repo.findSources();
    return sources.map((s) => ({
      ...s,
      webhookUrl: `/hooks/${s.provider}/${s.sourceKey}`,
    }));
  }

  @Post('sources')
  async createSource(@Req() req: any, @Body() body: any) {
    const repo = this.getTenantRepo(req);
    const masterKey = process.env.MASTER_KEY || DEV_MASTER_KEY;
    const sourceKey = body.sourceKey || `src_${body.provider}_${ulid().toLowerCase()}`;

    const source = await repo.createSource({
      provider: body.provider,
      name: body.name,
      sourceKey,
      isActive: true,
      secrets: {
        create: {
          secretEncrypted: aesGcmEncrypt(body.secret, masterKey),
          version: 1,
        },
      },
    } as any);

    return source;
  }

  // --- Destinations ---
  @Get('destinations')
  async listDestinations(@Req() req: any) {
    const repo = this.getTenantRepo(req);
    return repo.findDestinations();
  }

  @Post('destinations')
  async createDestination(@Req() req: any, @Body() body: any) {
    const repo = this.getTenantRepo(req);
    const masterKey = process.env.MASTER_KEY || DEV_MASTER_KEY;

    return repo.createDestination({
      name: body.name,
      type: body.type,
      configEncrypted: aesGcmEncrypt(JSON.stringify(body.config || {}), masterKey),
      signingSecretEncrypted: body.signingSecret ? aesGcmEncrypt(body.signingSecret, masterKey) : undefined,
      rateLimitRps: Number(body.rateLimitRps || 0),
    });
  }

  // --- Subscriptions ---
  @Get('subscriptions')
  async listSubscriptions(@Req() req: any) {
    const repo = this.getTenantRepo(req);
    return repo.findSubscriptions();
  }

  @Post('subscriptions')
  async createSubscription(@Req() req: any, @Body() body: any) {
    const repo = this.getTenantRepo(req);
    return this.prisma.subscription.create({
      data: {
        tenantId: repo.tenantId,
        destinationId: body.destinationId,
        name: body.name,
        eventTypes: body.eventTypes || [],
        template: body.template,
        isActive: true,
      },
      include: { destination: true },
    });
  }

  // --- Events (hỗ trợ Polling ADR-016 §8.1) ---
  @Get('events')
  async listEvents(@Req() req: any, @Query('after') after?: string, @Query('limit') limit = '50') {
    const repo = this.getTenantRepo(req);
    const take = Math.min(parseInt(limit, 10) || 50, 100);
    const events = await repo.findEvents({}, take, after);

    const nextCursor = events.length === take ? events[events.length - 1].id : null;
    return {
      events,
      nextCursor,
    };
  }

  @Get('events/:id')
  async getEventDetail(@Req() req: any, @Param('id') id: string) {
    const repo = this.getTenantRepo(req);
    const event = await repo.findEventById(id);
    return event;
  }

  // --- Deliveries & DLQ ---
  @Get('deliveries')
  async listDeliveries(@Req() req: any, @Query('status') status?: string) {
    const repo = this.getTenantRepo(req);
    const where = status ? { status: status as any } : {};
    return repo.findDeliveries(where, 50);
  }

  @Get('dlq')
  async listDlq(@Req() req: any) {
    const repo = this.getTenantRepo(req);
    return repo.findDeadDeliveries(50);
  }

  // --- Replay Delivery (§5.3 Replay: attempt_generation + 1) ---
  @Post('deliveries/:id/replay')
  async replayDelivery(@Req() req: any, @Param('id') id: string) {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id },
      include: { event: true, subscription: { include: { destination: true } } },
    });

    if (!delivery) {
      return { success: false, message: 'Delivery không tồn tại' };
    }

    // Tăng attempt_generation và tạo bản ghi mới để không vi phạm unique
    const newGen = delivery.attemptGeneration + 1;
    const replayed = await this.prisma.delivery.create({
      data: {
        tenantId: delivery.tenantId,
        eventId: delivery.eventId,
        subscriptionId: delivery.subscriptionId,
        attemptGeneration: newGen,
        status: 'PENDING',
        attemptCount: 0,
      },
    });

    const masterKey = process.env.MASTER_KEY || DEV_MASTER_KEY;
    const dest = delivery.subscription.destination;
    let config = {};
    try {
      config = JSON.parse(aesGcmDecrypt(dest.configEncrypted, masterKey));
    } catch {}

    let signingSecret: string | undefined;
    if (dest.signingSecretEncrypted) {
      try {
        signingSecret = aesGcmDecrypt(dest.signingSecretEncrypted, masterKey);
      } catch {}
    }

    const deliveryMsg = {
      deliveryId: replayed.id,
      tenantId: delivery.tenantId,
      eventId: delivery.eventId,
      subscriptionId: delivery.subscriptionId,
      destinationId: dest.id,
      destinationType: dest.type,
      config,
      signingSecret,
      event: {
        id: delivery.event.id,
        tenantId: delivery.event.tenantId,
        type: delivery.event.type,
        source: delivery.event.source,
        sourceId: '',
        subject: delivery.event.subject || undefined,
        data: delivery.event.data as any,
        occurredAt: delivery.event.occurredAt.toISOString(),
        receivedAt: delivery.event.receivedAt.toISOString(),
        correlationId: delivery.event.correlationId,
        rawEventId: delivery.event.rawEventId || undefined,
        origin: delivery.event.origin as any,
      },
      attemptCount: 0,
      attemptGeneration: newGen,
      correlationId: delivery.event.correlationId,
      rateLimitRps: dest.rateLimitRps,
    };

    // Thêm outbox để worker gửi lại (topic: delivery.replayed)
    await this.prisma.outbox.create({
      data: {
        topic: 'delivery.replayed',
        payload: deliveryMsg as any,
      },
    });

    return { success: true, newDeliveryId: replayed.id, generation: newGen };
  }
}
