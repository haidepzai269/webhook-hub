import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { logger } from '@hub/common';
import Redis from 'ioredis';

@WebSocketGateway({
  cors: { origin: '*' },
})
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private redisSub!: Redis;
  private metricsTimer!: NodeJS.Timeout;
  private eventCountPerMinute = 0;
  private successCountPerMinute = 0;

  afterInit(server: Server) {
    logger.info('Socket.IO Gateway đã khởi tạo');

    // Kết nối subscriber Redis để nhận sự kiện từ hub-worker
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    this.redisSub = new Redis(redisUrl, { lazyConnect: true });

    this.redisSub.connect().then(() => {
      this.redisSub.subscribe('hub:realtime:events', 'hub:realtime:deliveries', 'hub:realtime:orders', (err) => {
        if (err) {
          logger.warn({ err }, 'Lỗi đăng ký kênh Redis pub/sub cho realtime');
        } else {
          logger.info('Đã kết nối Redis pub/sub cho Socket.IO');
        }
      });

      this.redisSub.on('message', (channel, message) => {
        try {
          const data = JSON.parse(message);
          if (channel === 'hub:realtime:events') {
            this.server.emit('event.received', data);
            this.eventCountPerMinute++;
          } else if (channel === 'hub:realtime:deliveries') {
            this.server.emit('delivery.updated', data);
            if (data.status === 'SUCCEEDED') {
              this.successCountPerMinute++;
            }
          } else if (channel === 'hub:realtime:orders') {
            this.server.emit('order.updated', data);
          }
        } catch (e) {
          logger.error({ e }, 'Lỗi parse realtime message từ Redis');
        }
      });
    }).catch(() => {});

    // Định kỳ 5s gửi metrics.tick trong bộ nhớ (theo DEPLOYMENT §5.2)
    this.metricsTimer = setInterval(() => {
      if (this.server) {
        this.server.emit('metrics.tick', {
          timestamp: new Date().toISOString(),
          eventsPerMin: this.eventCountPerMinute * 12, // scale 60s
          successRate: this.eventCountPerMinute > 0 ? (this.successCountPerMinute / this.eventCountPerMinute) * 100 : 100,
        });
      }
      this.eventCountPerMinute = 0;
      this.successCountPerMinute = 0;
    }, 5000);
  }

  handleConnection(client: Socket) {
    logger.debug({ clientId: client.id }, 'Client kết nối tới Realtime Gateway');
  }

  handleDisconnect(client: Socket) {
    logger.debug({ clientId: client.id }, 'Client ngắt kết nối khỏi Realtime Gateway');
  }
}
