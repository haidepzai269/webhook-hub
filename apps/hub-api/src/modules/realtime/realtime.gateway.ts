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
import { ALERT_REALTIME_CHANNEL, logger, parseAlertChangedNotice, TraceIngestedNotice } from '@hub/common';
import Redis from 'ioredis';
import { TraceNotifier } from '../ingest/ingest.service';
import { AUTH_CONFIG, AuthConfig } from '../auth/auth-config';
import { verifySocketTicket } from '../auth/tokens';
import { onAccessRevoked } from './access-revocation';
import { dispatchRedisMessage, onRedisChannelAdded, registeredRedisChannels } from '../redis/redis-channels';

/** R-3: chu kỳ quét lại session + membership của socket đang mở (lưới an toàn cho instance khác / Redis không dùng). */
const RECHECK_MS = Number(process.env.SOCKET_RECHECK_MS) > 0 ? Number(process.env.SOCKET_RECHECK_MS) : 30_000;

/** SPEC-auth §5.7 (thay ADR-035): mỗi socket ở ĐÚNG một room project. Tên giữ cho log/metrics đọc được. */
const ROOM_PREFIX = 'project:';
const tenantRoom = (tenantId: string) => `${ROOM_PREFIX}${tenantId}`;

/** Kênh Redis (từ hub-worker) -> tên sự kiện Socket.IO. Chặng ở hub-api KHÔNG đi qua đây (in-process). */
export const REALTIME_CHANNELS: Record<string, string> = {
  'hub:realtime:events': 'event.received',
  'hub:realtime:deliveries': 'delivery.attempt',
  'hub:realtime:circuit': 'circuit.changed',
  // CB3 (SPEC-canh-bao §5.3, ADR-169): cảnh báo đổi trạng thái -> CHỈ room của project trong tin (socket đang mở project
  // đó). Không có room "operator": chuông xuyên project gọi lại GET /alerts/summary khi nhận tin này + poll 30s.
  [ALERT_REALTIME_CHANNEL]: 'alert.changed',
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
  private recheckTimer?: NodeJS.Timeout;
  private offRevoked?: () => void;
  private offChannelAdded?: () => void;
  private lastSubWarn = 0;

  constructor(
    private readonly jwtService: JwtService,
    @Inject(AUTH_CONFIG) private readonly authCfg: AuthConfig,
    // Vé hợp lệ vẫn phải có session còn sống (logout-all ngắt được cả socket mới). Vắng -> từ chối mọi kết nối.
    // Kiểu PHẢI là lớp PrismaService (không Pick<>): Nest đọc design:paramtypes — Pick<> thành Object và không inject được.
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  afterInit(server: Server) {
    logger.info('Socket.IO Gateway đã khởi tạo');

    server.use((socket, next) => this.authenticate(socket, next));
    // R-3: mất quyền / mất phiên -> ngắt socket đang mở (trước đây chỉ kiểm lúc handshake).
    this.offRevoked = onAccessRevoked((userId) => void this.recheckSockets(userId));
    this.recheckTimer = setInterval(() => void this.recheckSockets(), RECHECK_MS);
    this.recheckTimer.unref?.();

    // Kết nối subscriber Redis để nhận sự kiện từ hub-worker
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    this.redisSub = new Redis(redisUrl, { lazyConnect: true });

    // ADR-180: CÙNG connection này phục vụ cả kênh của module khác (redis-channels.ts) — không mở subscriber thứ hai.
    // Review T-1: handler gắn NGOÀI promise connect; subscribe ở MỖI lần 'ready' (lần đầu, và sau mỗi lần kết nối lại —
    // gồm cả khi lần connect đầu lỗi: ioredis vẫn tự thử lại, trước đây `.then` không bao giờ chạy -> realtime chết vĩnh viễn).
    // Kênh đăng ký lúc chưa ready (connecting/reconnecting) được subscribe ở lần 'ready' kế tiếp.
    this.redisSub.on('message', (channel, message) => {
      if (REALTIME_CHANNELS[channel]) this.handleRedisMessage(channel, message);
      else dispatchRedisMessage(channel, message);
    });
    this.redisSub.on('ready', () => this.subscribeAll());
    this.redisSub.on('error', (err: Error) => {
      const t = Date.now();
      if (t - this.lastSubWarn < 60_000) return;
      this.lastSubWarn = t;
      logger.warn({ err: err.message }, 'Redis subscriber realtime lỗi -> ioredis tự kết nối lại, subscribe lại khi ready');
    });
    this.offChannelAdded = onRedisChannelAdded((channel) => {
      if (this.redisSub.status !== 'ready') return; // chưa ready: lần 'ready' tới sẽ subscribe đủ
      this.redisSub.subscribe(channel).catch((err: Error) => logger.warn({ err: err.message, channel }, 'Không subscribe được kênh Redis'));
    });
    this.redisSub.connect().catch((err: Error) =>
      logger.warn({ err: err.message }, 'Redis subscriber realtime: kết nối lần đầu lỗi -> ioredis tự thử lại, subscribe khi ready'),
    );

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

  /** Subscribe kênh realtime + mọi kênh đã đăng ký ở registry. Gọi ở MỖI lần 'ready' (SUBSCRIBE trùng là vô hại). */
  private subscribeAll() {
    this.redisSub.subscribe(...Object.keys(REALTIME_CHANNELS), ...registeredRedisChannels(), (err) => {
      if (err) logger.warn({ err }, 'Lỗi đăng ký kênh Redis pub/sub cho realtime');
      else logger.info('Đã kết nối Redis pub/sub cho Socket.IO');
    });
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
    if (eventName === 'alert.changed') {
      // Chỉ đúng 6 trường của hợp đồng (không `facts` thô, không trường lạ); sai hình -> bỏ.
      data = parseAlertChangedNotice(data);
      if (!data) {
        logger.warn({ channel }, 'Realtime alert.changed sai hình, bỏ qua');
        return;
      }
    }
    const tenantId = data?.tenantId;
    if (typeof tenantId !== 'string' || !tenantId) {
      logger.warn({ channel }, 'Realtime message thiếu tenantId, bỏ qua');
      return;
    }
    this.server.to(tenantRoom(tenantId)).emit(eventName, data);
    if (eventName === 'alert.changed') return; // không đụng bộ đếm metrics.tick
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
        socket.data.sid = claims.sid;
        next();
      })
      .catch(() => next(new Error('UNAUTHORIZED')));
  }

  /**
   * R-3 (ADR-112): kiểm lại các socket ĐANG MỞ của instance này (chỉ của `userId` nếu có) bằng HAI truy vấn theo lô:
   * session còn sống? còn là thành viên project của vé (operator thì luôn được)? Không -> `disconnect(true)`.
   * Lỗi DB -> giữ nguyên (lượt sau kiểm lại), không ngắt oan.
   */
  async recheckSockets(userId?: string): Promise<number> {
    if (!this.prisma || !this.server) return 0;
    const sockets = [...(this.server.sockets?.sockets?.values() ?? [])].filter(
      (s) => typeof s.data?.sid === 'string' && (!userId || s.data.userId === userId),
    );
    if (sockets.length === 0) return 0;
    const sids = [...new Set(sockets.map((s) => s.data.sid as string))];
    const pairKeys = new Map<string, { userId: string; projectId: string }>();
    for (const s of sockets) pairKeys.set(`${s.data.userId}:${s.data.tenantId}`, { userId: s.data.userId, projectId: s.data.tenantId });
    let access: { live: Map<string, { userId: string; isOperator: boolean }>; members: Set<string> };
    try {
      access = await this.prisma.identity().socketAccess(sids, [...pairKeys.values()], new Date());
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Realtime: kiểm lại socket lỗi DB -> giữ nguyên tới lượt sau');
      return 0;
    }
    let n = 0;
    for (const s of sockets) {
      const sess = access.live.get(s.data.sid);
      const ok = !!sess && sess.userId === s.data.userId && (sess.isOperator || access.members.has(`${s.data.userId}:${s.data.tenantId}`));
      if (!ok) {
        s.disconnect(true);
        n++;
      }
    }
    if (n > 0) logger.info({ disconnected: n, userId: userId ?? null }, 'Realtime: ngắt socket mất phiên / mất quyền (R-3)');
    return n;
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
    if (this.recheckTimer) clearInterval(this.recheckTimer);
    this.offRevoked?.();
    this.offChannelAdded?.();
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
