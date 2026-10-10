// R-4 (review AU, ADR-119) — tải ĐƯỜNG GIAO: service publish -> normalize -> outbox -> delivery consumer -> endpoint.
// Đo độ trễ "event vào hub -> delivery SUCCEEDED" bằng SQL sau lượt chạy (k6 chỉ tạo tải + in RUN id).
// Chạy trên stack kiểm chứng hubv (LOCAL, ADR-019), vào thẳng mạng compose, đích là sink trả 200 ngay:
//
//   docker run --rm -i --network hubv_default -e HUB_URL=http://hub-api:4000 grafana/k6:0.54.0 run - < k6/delivery-e2e.js
//   bash scripts/delivery-latency.sh <RUN>      # p50/p95/p99 từ Postgres của hubv
//
// Biến: HUB_URL · OPERATOR_EMAIL / OPERATOR_PASSWORD (operator của .env.verify) · PROJECT (cafe) · RPS (30) · DURATION_S (60)
// setup(): operator đăng nhập (cookie gửi tay — __Host-/Secure trên http), tạo key 3 scope cho PROJECT; key tạo endpoint
// http://sink:4100/k6 (qua challenge) + subscription `k6.delivered`. teardown(): tắt subscription (lần sau không cộng dồn).
import http from 'k6/http';
import { check } from 'k6';

const HUB_URL = __ENV.HUB_URL || 'http://hub-api:4000';
const PROJECT = __ENV.PROJECT || 'cafe';
const RPS = parseInt(__ENV.RPS || '30', 10);
const DURATION_S = parseInt(__ENV.DURATION_S || '60', 10);
const RUN = __ENV.RUN || `${Date.now().toString(36)}`;
const JSON_H = { 'content-type': 'application/json' };

export const options = {
  scenarios: {
    publish: { executor: 'constant-arrival-rate', rate: RPS, timeUnit: '1s', duration: `${DURATION_S}s`, preAllocatedVUs: 20, maxVUs: 100 },
  },
  thresholds: { http_req_failed: ['rate<0.01'] },
};

function cookieHeader(res) {
  return Object.entries(res.cookies)
    .map(([k, v]) => `${k}=${v[0].value}`)
    .join('; ');
}

export function setup() {
  const login = http.post(
    `${HUB_URL}/auth/login`,
    JSON.stringify({ email: __ENV.OPERATOR_EMAIL || 'operator@verify.local', password: __ENV.OPERATOR_PASSWORD || 'VERIFY_ONLY_admin_password' }),
    { headers: JSON_H },
  );
  if (login.status !== 200) throw new Error(`login ${login.status} ${login.body}`);
  const cookie = cookieHeader(login);
  const csrf = login.cookies.hub_csrf[0].value;
  const auth = { ...JSON_H, cookie, 'x-csrf-token': decodeURIComponent(csrf) };
  const project = JSON.parse(http.get(`${HUB_URL}/api/v1/projects`, { headers: auth }).body).find((p) => p.slug === PROJECT);
  const keyRes = http.post(
    `${HUB_URL}/api/v1/projects/${project.id}/keys`,
    JSON.stringify({ serviceName: `k6-${RUN}`, scopes: ['publish:events', 'read:events', 'manage:endpoints'] }),
    { headers: auth },
  );
  if (keyRes.status !== 201) throw new Error(`key ${keyRes.status} ${keyRes.body}`);
  const key = JSON.parse(keyRes.body).key;
  const bearer = { ...JSON_H, authorization: `Bearer ${key}` };
  const ep = http.post(`${HUB_URL}/v1/p/${PROJECT}/endpoints`, JSON.stringify({ name: `k6-${RUN}`, url: 'http://sink:4100/k6' }), { headers: bearer });
  if (ep.status !== 201) throw new Error(`endpoint ${ep.status} ${ep.body}`);
  const sub = http.post(
    `${HUB_URL}/v1/p/${PROJECT}/subscriptions`,
    JSON.stringify({ name: `k6-${RUN}`, endpointId: JSON.parse(ep.body).id, eventTypes: ['k6.delivered'] }),
    { headers: bearer },
  );
  if (sub.status !== 201) throw new Error(`subscription ${sub.status} ${sub.body}`);
  console.log(`RUN=${RUN}`);
  return { key, sub: JSON.parse(sub.body).id };
}

export default function (data) {
  const id = `${RUN}-${__VU}-${__ITER}`;
  const res = http.post(
    `${HUB_URL}/v1/p/${PROJECT}/events`,
    JSON.stringify({ type: 'k6.delivered', idempotencyKey: id, data: { run: RUN, id } }),
    { headers: { ...JSON_H, authorization: `Bearer ${data.key}` } },
  );
  check(res, { '202': (r) => r.status === 202 });
}

export function teardown(data) {
  http.patch(`${HUB_URL}/v1/p/${PROJECT}/subscriptions/${data.sub}`, JSON.stringify({ isActive: false }), {
    headers: { ...JSON_H, authorization: `Bearer ${data.key}` },
  });
  console.log(`RUN=${RUN} — đo: bash scripts/delivery-latency.sh ${RUN}`);
}
