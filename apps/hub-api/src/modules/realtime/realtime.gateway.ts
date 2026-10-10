import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Inject, OnModuleDestroy, Optional } from '@nestjs/common';
import { PrismaService } from '@hub/database';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { logger, TraceIngestedNotice } from '@hub/common';
import Redis from 'ioredis';
import { TraceNotifier } from '../ingest/ingest.service';
import { AUTH_CONFIG, AuthConfig } from '../auth/auth-config';
import { verifySocketTicket } from '../auth/tokens';

/** SPEC-auth §5.7 (thay ADR-035): mỗi socket ở ĐÚNG một room project. Tên giữ cho log/metrics đọc được. */
const ROOM_PREFIX = 'project:';
const tenantRoom = (tenantId: string) => `${ROOM_PREFIX}${tenantId}`;

/** Kênh Redis (từ hub-worker) -> tên sự kiện Socket.IO. Chặng ở hub-api KHÔNG đi qua đây (in-process). */
export const REALTIME_CHANNELS: Record<string, string> = {
  'hub:realtime:events': 'event.received',
  'hub:realtime:deliveries': 'delivery.attempt',
  'hub:realtime:circuit': 'circuit.changed',
};

export interface TickCounter {
  events: number;
  success: number;
  done: number;
}

/** `successRate = null` khi chưa có delivery nào ra kết quả cuối — UI hiện "—", không bịa 100%. */
export function computeTick(c: TickCounter | undefined, now = new Date()) {
  const counter = c ?? { events: 0, success: 0, done: 0 };
  return {
    timestamp: now.toISOString(),
    eventsPerMin: counter.events * 12, // cửa sổ 5s -> scale 60s
    successRate: counter.done > 0 ? (counter.success / counter.done) * 100 : null,
  };
}

/**
 * Realtime cho dashboard (SPEC-auth §5.7). Mọi kết nối PHẢI mang vé socket (`handshake.auth.ticket`) xin từ
 * `GET /auth/socket-ticket?projectId=` — vé đã qua ĐÚNG luật phạm vi project của console (resolveProjectScope).
 * Middleware kiểm vé (HS256, aud 'socket', exp 60s, khoá riêng) VÀ session còn sống trước khi chấp nhận kết nối;
 * socket vào room `project:<tid>`; mọi emit đi vào room, không broadcast toàn server (BB-5).
 */
@WebSocketGateway({
  cors: { origin: '*' }, // auth bằng vé trong handshake, không dùng cookie -> origin không phải lớp bảo vệ
})
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy, TraceNotifier
{
  @WebSocketServer()
  server!: Server;

  private redisSub!: Redis;
  private metricsTimer!: NodeJS.Timeout;
  // Đếm trong bộ nhớ theo tenant, KHÔNG chạm Redis mỗi tick (DEPLOYMENT §5.2)
  // done = delivery đã ra kết quả cuối (SUCCEEDED|DEAD) -> successRate không vượt 100% khi fan-out nhiều subscription
  private counters = new Map<string, TickCounter>();

  constructor(
    private readonly jwtService: JwtService,
    @Inject(AUTH_CONFIG) private readonly authCfg: AuthConfig,
    // Vé hợp lệ vẫn phải có session còn sống (logout-all ngắt được cả socket mới). Vắng -> từ chối mọi kết nối.
    @Optional() private readonly prisma?: Pick<PrismaService, 'identity'>,
  ) {}

  afterInit(server: Server) {
    logger.info('Socket.IO Gateway đã khởi tạo');

    server.use((socket, next) => this.authenticate(socket, next));

    // Kết nối subscriber Redis để nhận sự kiện từ hub-worker
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    this.redisSub = new Redis(redisUrl, { lazyConnect: true });

    this.redisSub.connect().then(() => {
      this.redisSub.subscribe(...Object.keys(REALTIME_CHANNELS), (err) => {
        if (err) {
          logger.warn({ err }, 'Lỗi đăng ký kênh Redis pub/sub cho realtime');
        } else {
          logger.info('Đã kết nối Redis pub/sub cho Socket.IO');
        }
      });

      this.redisSub.on('message', (channel, message) => this.handleRedisMessage(channel, message));
    }).catch(() => {});

    // Định kỳ 5s gửi metrics.tick theo từng tenant đang có người xem
    this.metricsTimer = setInterval(() => {
      if (!this.server) return;
      const rooms = this.server.sockets.adapter.rooms;
      for (const [room] of rooms) {
        if (!room.startsWith(ROOM_PREFIX)) continue;
        const tenantId = room.slice(ROOM_PREFIX.length);
        this.server.to(room).emit('metrics.tick', computeTick(this.counters.get(tenantId)));
      }
      this.counters.clear();
    }, 5000);
  }

  /**
   * Tin từ hub-worker qua Redis. Thiếu tenantId -> bỏ (thà mất một cập nhật còn hơn lộ chéo tenant).
   * Mọi emit đi vào room của tenant trong payload (BB-5).
   */
  handleRedisMessage(channel: string, message: string) {
    const eventName = REALTIME_CHANNELS[channel];
    if (!eventName) return;
    let data: any;
    try {
      data = JSON.parse(message);
    } catch (e) {
      logger.error({ e, channel }, 'Lỗi parse realtime message từ Redis');
      return;
    }
    const tenantId = data?.tenantId;
    if (typeof tenantId !== 'string' || !tenantId) {
      logger.warn({ channel }, 'Realtime message thiếu tenantId, bỏ qua');
      return;
    }
    this.server.to(tenantRoom(tenantId)).emit(eventName, data);
    const c = this.counterFor(tenantId);
    if (eventName === 'event.received') {
      c.events += Array.isArray(data.events) ? data.events.length : 1;
    } else if (eventName === 'delivery.attempt') {
      if (data.status === 'SUCCEEDED') c.success++;
      if (data.status === 'SUCCEEDED' || data.status === 'DEAD') c.done++;
    }
  }

  /** S2-2: chặng ①–④ ở hub-api — emit thẳng, 0 lệnh Redis. Chỉ tới được client nối vào CÙNG instance. */
  traceIngested(tenantId: string, notice: TraceIngestedNotice) {
    this.server?.to(tenantRoom(tenantId)).emit('trace.ingested', notice);
  }

  /** Middleware handshake: thiếu/sai/hết hạn vé, hoặc session đã chết -> từ chối (client nhận connect_error). */
  authenticate(socket: Pick<Socket, 'handshake' | 'data'>, next: (err?: Error) => void) {
    const ticket = socket.handshake.auth?.ticket;
    const claims = typeof ticket === 'string' && ticket ? verifySocketTicket(this.jwtService, this.authCfg, ticket) : null;
    if (!claims) return next(new Error('UNAUTHORIZED'));
    if (!this.prisma) {
      logger.warn('Realtime: gateway không có PrismaService -> không kiểm được session -> từ chối');
      return next(new Error('UNAUTHORIZED'));
    }
    this.prisma
      .identity()
      .findLiveSessionWithUser(claims.sid, new Date())
      .then((session) => {
        if (!session || session.userId !== claims.sub) return next(new Error('UNAUTHORIZED'));
        socket.data.tenantId = claims.tid;
        socket.data.userId = claims.sub;
        next();
      })
      .catch(() => next(new Error('UNAUTHORIZED')));
  }

  private counterFor(tenantId: string) {
    let c = this.counters.get(tenantId);
    if (!c) {
      c = { events: 0, success: 0, done: 0 };
      this.counters.set(tenantId, c);
    }
    return c;
  }

  onModuleDestroy() {
    clearInterval(this.metricsTimer);
    this.redisSub?.quit().catch(() => {});
  }

  handleConnection(client: Socket) {
    // Middleware ở afterInit đã kiểm vé + session; tới đây chắc chắn có tenantId (= project của vé)
    client.join(tenantRoom(client.data.tenantId));
    logger.debug({ clientId: client.id }, 'Client kết nối tới Realtime Gateway');
  }

  handleDisconnect(client: Socket) {
    logger.debug({ clientId: client.id }, 'Client ngắt kết nối khỏi Realtime Gateway');
  }
}
