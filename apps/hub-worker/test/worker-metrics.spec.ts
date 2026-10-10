import * as http from 'http';
import { AddressInfo } from 'net';
import { startMetricsServer, deliveriesTotal, outboxLag } from '../src/metrics';

/** S3-4: worker phục vụ `/metrics` bằng http server tối giản; cổng 0 = tắt. */
describe('worker /metrics (S3-4)', () => {
  it('WORKER_METRICS_PORT=0 -> không mở server', () => {
    expect(startMetricsServer(0)).toBeNull();
  });

  it('GET /metrics trả đủ tên chỉ số; đường khác 404', async () => {
    deliveriesTotal.inc({ destination_type: 'webhook', status: 'SUCCEEDED' });
    outboxLag.set(1.5);
    const server = http.createServer();
    // lấy cổng trống rồi đóng, mở metrics server ở cổng đó
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((r) => server.close(() => r()));
    const ms = startMetricsServer(port)!;
    await new Promise((r) => ms.once('listening', r));
    try {
      const get = (path: string) =>
        new Promise<{ status: number; body: string }>((resolve, reject) => {
          http.get(`http://127.0.0.1:${port}${path}`, (res) => {
            let b = '';
            res.on('data', (c) => (b += c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
          }).on('error', reject);
        });
      const ok = await get('/metrics');
      expect(ok.status).toBe(200);
      for (const name of [
        'hub_deliveries_total{destination_type="webhook",status="SUCCEEDED"}',
        'hub_delivery_duration_seconds',
        'hub_circuit_transitions_total',
        'hub_outbox_lag_seconds 1.5',
        'hub_normalize_retries_total',
        'hub_normalize_schema_errors_total',
      ]) {
        expect(ok.body).toContain(name);
      }
      expect((await get('/x')).status).toBe(404);
    } finally {
      await new Promise<void>((r) => ms.close(() => r()));
    }
  });
});
