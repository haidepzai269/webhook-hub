import { PrismaClient, Source, Destination, Subscription, Event, Delivery, Prisma } from '@prisma/client';

export class TenantScopedRepository {
  constructor(
    private readonly prisma: PrismaClient,
    public readonly tenantId: string,
  ) {
    if (!tenantId) {
      throw new Error('TenantScopedRepository: tenantId là bắt buộc (BB-5 vi phạm)');
    }
  }

  // --- Sources ---
  async findSources(where: Prisma.SourceWhereInput = {}) {
    return this.prisma.source.findMany({
      where: { ...where, tenantId: this.tenantId },
      include: { secrets: true },
    });
  }

  async findSourceById(id: string) {
    return this.prisma.source.findFirst({
      where: { id, tenantId: this.tenantId },
      include: { secrets: true },
    });
  }

  async createSource(data: Omit<Prisma.SourceUncheckedCreateInput, 'tenantId'>) {
    return this.prisma.source.create({
      data: { ...data, tenantId: this.tenantId },
      include: { secrets: true },
    });
  }

  // --- Destinations ---
  async findDestinations(where: Prisma.DestinationWhereInput = {}) {
    return this.prisma.destination.findMany({
      where: { ...where, tenantId: this.tenantId },
    });
  }

  async findDestinationById(id: string) {
    return this.prisma.destination.findFirst({
      where: { id, tenantId: this.tenantId },
    });
  }

  async createDestination(data: Omit<Prisma.DestinationUncheckedCreateInput, 'tenantId'>) {
    return this.prisma.destination.create({
      data: { ...data, tenantId: this.tenantId },
    });
  }

  // --- Subscriptions ---
  async findSubscriptions(where: Prisma.SubscriptionWhereInput = {}) {
    return this.prisma.subscription.findMany({
      where: { ...where, tenantId: this.tenantId },
      include: { destination: true },
    });
  }

  async findActiveSubscriptionsForEventType(eventType: string) {
    return this.prisma.subscription.findMany({
      where: {
        tenantId: this.tenantId,
        isActive: true,
        eventTypes: { has: eventType },
      },
      include: { destination: true },
    });
  }

  // --- Events ---
  async findEvents(where: Prisma.EventWhereInput = {}, take = 50, cursor?: string) {
    return this.prisma.event.findMany({
      where: { ...where, tenantId: this.tenantId },
      take,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { receivedAt: 'desc' },
      include: { deliveries: true },
    });
  }

  async findEventById(id: string) {
    return this.prisma.event.findFirst({
      where: { id, tenantId: this.tenantId },
      include: {
        rawEvent: true,
        deliveries: {
          include: {
            attempts: { orderBy: { attemptNo: 'asc' } },
            subscription: { include: { destination: true } },
          },
        },
      },
    });
  }

  // --- Deliveries ---
  async findDeliveries(where: Prisma.DeliveryWhereInput = {}, take = 50) {
    return this.prisma.delivery.findMany({
      where: { ...where, tenantId: this.tenantId },
      take,
      orderBy: { createdAt: 'desc' },
      include: {
        event: true,
        subscription: { include: { destination: true } },
        attempts: true,
      },
    });
  }

  async findDeadDeliveries(take = 50) {
    return this.findDeliveries({ status: 'DEAD' }, take);
  }
}
