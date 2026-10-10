// S3-4 — tải ingest GitHub: ký HMAC đúng trên đúng bytes gửi đi, mỗi request một X-GitHub-Delivery.
// Bắn vào hub LOCAL (CLAUDE.md cạm bẫy 5: không qua tunnel, không đo trên deployed — ADR-019).
//
//   docker run --rm -i --network host -e HUB_URL=http://localhost:4000 grafana/k6:0.54.0 run - < k6/ingest-github.js
//
// Biến: HUB_URL (http://localhost:4000) · SOURCE_KEY (src_github_main) · GITHUB_WEBHOOK_SECRET (seed mặc định)
//       EVENT (k6_load) · STAGE_S (60: số giây mỗi bậc 10 → 50 → 100 RPS)
//
// EVENT mặc định `k6_load` -> kiểu `github.k6_load` (normalized:false) KHÔNG khớp subscription nào:
// đo đúng chặng ingest mà không spam Discord/Telegram. Muốn đo cả delivery thì tạo subscription tới
// đích mock (`/mock/discord`) cho `github.k6_load`.
import http from 'k6/http';
import crypto from 'k6/crypto';
import { check } from 'k6';

const HUB_URL = __ENV.HUB_URL || 'http://localhost:4000';
const SOURCE_KEY = __ENV.SOURCE_KEY || 'src_github_main';
const SECRET = __ENV.GITHUB_WEBHOOK_SECRET || 'gh_webhook_secret_test_123';
const EVENT = __ENV.EVENT || 'k6_load';
const STAGE_S = parseInt(__ENV.STAGE_S || '60', 10);

export const options = {
  scenarios: {
    ingest: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 50,
      maxVUs: 200,
      stages: [
        { target: 10, duration: `${STAGE_S}s` },
        { target: 50, duration: `${STAGE_S}s` },
        { target: 100, duration: `${STAGE_S}s` },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<200'],
    http_req_failed: ['rate<0.01'],
  },
};

function uuid() {
  const h = crypto.sha256(`${__VU}-${__ITER}-${Date.now()}-${Math.random()}`, 'hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export default function () {
  const delivery = uuid();
  const body = JSON.stringify({
    action: 'run',
    k6: { vu: __VU, iter: __ITER, delivery },
    repository: { name: 'k6', full_name: 'load/k6', html_url: 'https://github.com/load/k6' },
    sender: { login: 'k6' },
  });
  const sig = 'sha256=' + crypto.hmac('sha256', SECRET, body, 'hex');
  const res = http.post(`${HUB_URL}/hooks/github/${SOURCE_KEY}`, body, {
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': EVENT,
      'X-GitHub-Delivery': delivery,
      'X-Hub-Signature-256': sig,
    },
  });
  check(res, { 'status 200': (r) => r.status === 200 });
}
