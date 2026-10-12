'use strict';
/**
 * EG1 (SPEC-chong-qua-tai §3, ADR-175/176): dựng cấu hình nginx từ `docker/nginx/nginx.conf.template` bằng `envsubst`.
 *
 * - `envsubst` nhận DANH SÁCH BIẾN CỐ ĐỊNH (EDGE_ENVSUBST_VARS) và env CHỈ gồm các biến đó -> `$remote_addr`, `$uri`… của
 *   nginx và mọi biến môi trường khác (secret!) không bao giờ bị chèn vào file cấu hình.
 * - Mọi giá trị được kiểm/kẹp TRƯỚC khi chèn (số trong khoảng hợp lệ, CIDR đúng khuôn, upstream host:port) — cấu hình
 *   sai thì THOÁT lúc khởi động với thông báo rõ, không chạy nửa vời.
 * - Dùng cho cả hai chỗ: `docker/hub-all.js` (EDGE_NGINX=1) và `docker-entrypoint.sh edge` (service `edge` local).
 *
 *   node docker/nginx/edge.js render   -> dựng file, in đường dẫn file cấu hình ra stdout (entrypoint `edge` dùng)
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TEMPLATE = path.join(__dirname, 'nginx.conf.template');
const EDGE_ENVSUBST_VARS = [
  'EDGE_PREFIX',
  'EDGE_LISTEN',
  'EDGE_UPSTREAM',
  'EDGE_REAL_IP',
  'EDGE_IP_FUSE',
  'EDGE_IP_RATE',
  'EDGE_IP_BURST',
  'EDGE_CONN_PER_IP',
  'HUB_DOCS_URL',
  'EDGE_ACCESS_LOG',
  'EDGE_SHUTDOWN_TIMEOUT',
];

/** Mặc định (§3.3, §3.4). Kẹp như `resolveSendTimeoutMs`: ngoài khoảng -> giá trị biên, không phải lỗi. */
const LIMITS = {
  EDGE_IP_RATE: { def: 50, min: 1, max: 100_000 },
  EDGE_IP_BURST: { def: 500, min: 0, max: 1_000_000 },
  EDGE_CONN_PER_IP: { def: 50, min: 1, max: 100_000 },
};

const on = (v) => ['1', 'true', 'on', 'yes'].includes(String(v ?? '').trim().toLowerCase());

function clampInt(env, name) {
  const { def, min, max } = LIMITS[name];
  const raw = env[name];
  const n = raw === undefined || String(raw).trim() === '' ? def : parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9A-Fa-f:]+$/;

/** Một phần tử của EDGE_TRUSTED_PROXIES: IPv4/IPv6, có thể kèm /prefix. Sai khuôn -> null (gọi hàm sẽ ném lỗi). */
function normalizeCidr(item) {
  const [addr, prefix, extra] = item.split('/');
  if (extra !== undefined) return null;
  const v4 = IPV4.test(addr);
  const v6 = !v4 && IPV6.test(addr) && addr.includes(':') && (addr.match(/::/g) || []).length <= 1;
  if (!v4 && !v6) return null;
  if (prefix !== undefined) {
    if (!/^\d{1,3}$/.test(prefix)) return null;
    const p = Number(prefix);
    if (p > (v4 ? 32 : 128)) return null;
  }
  return item;
}

/** Dải coi là "quá rộng" để tin đệ quy: /0, IPv4 ngắn hơn /8, IPv6 ngắn hơn /16. Địa chỉ đơn lẻ không bao giờ rộng. */
function tooWide(item) {
  const [addr, prefix] = item.split('/');
  if (prefix === undefined) return false;
  return Number(prefix) < (addr.includes(':') ? 16 : 8);
}

/** Thời gian hub-api chờ nginx khi tắt máy (EDGE_DRAIN_MS, mặc định 16 s), kẹp để hub-api còn ≥ 6 s trước SIGKILL. */
function edgeDrainMs(env, supervisorTimeout = parseInt(env.SHUTDOWN_TIMEOUT_MS || '25000', 10)) {
  const n = parseInt(env.EDGE_DRAIN_MS || '16000', 10);
  return Math.max(0, Math.min(Number.isFinite(n) ? n : 16_000, supervisorTimeout - 6000));
}

/** `worker_shutdown_timeout` của nginx: luôn NHỎ hơn thời gian hub-api chờ (drain - 1 s, tối thiểu 1 s). */
function nginxShutdownSeconds(env) {
  return Math.max(1, Math.floor(edgeDrainMs(env) / 1000) - 1);
}

/**
 * §3.2 — khối real_ip:
 * - EDGE_TRUSTED_PROXIES trống: KHÔNG tin header nào, `$remote_addr` = địa chỉ kết nối TCP (đúng ở local: không có proxy
 *   phía trước; SAI trên Render: mọi request mang IP proxy Render — xem ADR-176, DEPLOYMENT "Đo IP thật").
 * - Có danh sách: `set_real_ip_from` từng dải + `real_ip_header X-Forwarded-For` + `real_ip_recursive` (mặc định on).
 *   `0.0.0.0/0,::/0` + EDGE_REAL_IP_RECURSIVE=off = lấy phần tử CUỐI của XFF = đúng hành vi `trust proxy 1` hôm nay.
 */
function realIpBlock(env) {
  const raw = String(env.EDGE_TRUSTED_PROXIES ?? '').trim();
  if (!raw) return '    # EDGE_TRUSTED_PROXIES trống: $remote_addr = địa chỉ kết nối TCP (không tin X-Forwarded-For).';
  const items = raw.split(/[\s,]+/).filter(Boolean);
  const bad = items.filter((i) => normalizeCidr(i) === null);
  if (bad.length) throw new Error(`EDGE_TRUSTED_PROXIES có phần tử không phải IP/CIDR: ${bad.join(', ')}`);
  const rec = String(env.EDGE_REAL_IP_RECURSIVE ?? 'on').trim().toLowerCase();
  if (rec !== 'on' && rec !== 'off') throw new Error('EDGE_REAL_IP_RECURSIVE chỉ nhận on|off');
  // Review EG1 #2: recursive on + dải tin cậy quá rộng (/0, IPv4 < /8, IPv6 < /16) = mọi phần tử XFF đều "tin cậy" ->
  // nginx lấy phần tử ĐẦU, tức IP do client tự đặt. Không tự sửa ngầm: từ chối khởi động.
  const wide = items.filter(tooWide);
  if (rec === 'on' && wide.length) {
    throw new Error(
      `EDGE_TRUSTED_PROXIES có dải quá rộng (${wide.join(', ')}) mà EDGE_REAL_IP_RECURSIVE=on: nginx sẽ lấy phần tử ĐẦU của X-Forwarded-For (IP client tự đặt). Đặt EDGE_REAL_IP_RECURSIVE=off (lấy phần tử cuối) hoặc dùng dải hẹp của proxy`,
    );
  }
  return [
    ...items.map((i) => `    set_real_ip_from ${i};`),
    '    real_ip_header X-Forwarded-For;',
    `    real_ip_recursive ${rec};`,
  ].join('\n');
}

/**
 * Giá trị chèn vào template. `listenPort`/`upstream` do bên gọi quyết (hub-all: $PORT + 127.0.0.1:EDGE_API_PORT;
 * service `edge`: $PORT + EDGE_UPSTREAM).
 * @returns {{vars: Record<string,string>, warnings: {level:number, msg:string}[]}}
 */
function edgeVars(env, { listenPort, upstream, prefix, accessLog = '/dev/stdout' }) {
  const port = parseInt(String(listenPort), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`cổng nginx không hợp lệ: ${listenPort}`);
  if (!/^[A-Za-z0-9.-]+:\d{1,5}$/.test(String(upstream))) throw new Error(`EDGE_UPSTREAM phải là host:port, nhận: ${upstream}`);
  const docs = String(env.HUB_DOCS_URL || 'docs/ERRORS.md');
  // Chèn vào chuỗi JSON trong `return '…'` của nginx: cấm nháy, \, khoảng trắng, $ và {}.
  if (!/^[A-Za-z0-9:/._?=&%~+#-]+$/.test(docs)) throw new Error('HUB_DOCS_URL có ký tự không cho phép trong cấu hình nginx');
  if (!/^\/[A-Za-z0-9._/-]+$/.test(prefix)) throw new Error(`thư mục nginx không hợp lệ: ${prefix}`);
  if (accessLog !== '/dev/stdout' && !/^syslog:server=127\.0\.0\.1:\d{1,5},tag=edge,nohostname$/.test(accessLog)) {
    throw new Error(`đích access log không hợp lệ: ${accessLog}`);
  }
  const fuse = on(env.EDGE_IP_FUSE);
  const trusted = String(env.EDGE_TRUSTED_PROXIES ?? '').trim();
  /** @type {{level:number, msg:string}[]} */
  const warnings = [];
  // Review EG1 #3: trên Render (env RENDER) mọi kết nối tới container đến từ proxy Render. Không khai proxy tin cậy =
  // req.ip của MỌI người là IP Render: rate limit đăng nhập chung một xô, limit_conn thành trần chung, hộp phạt EG2
  // phạt tất cả. Từ chối khởi động, trừ khi cố ý vượt bằng EDGE_ALLOW_NO_REAL_IP=1 (khi đó vẫn cảnh báo level 50).
  if (!trusted && env.RENDER) {
    if (!on(env.EDGE_ALLOW_NO_REAL_IP)) {
      throw new Error(
        'EDGE_NGINX trên Render cần EDGE_TRUSTED_PROXIES (lần đầu: 0.0.0.0/0,::/0 + EDGE_REAL_IP_RECURSIVE=off, xem DEPLOYMENT §3.6). Trống = mọi request mang IP proxy Render. Cố ý chạy vậy: EDGE_ALLOW_NO_REAL_IP=1',
      );
    }
    warnings.push({ level: 50, msg: 'EDGE_ALLOW_NO_REAL_IP=1: chạy sau proxy Render mà KHÔNG đọc IP thật — req.ip của mọi người là IP proxy (rate limit IP, limit_conn, hộp phạt dùng chung một khoá).' });
  }
  if (fuse && !trusted) {
    warnings.push({
      level: env.RENDER ? 50 : 40,
      msg: 'EDGE_IP_FUSE=1 nhưng EDGE_TRUSTED_PROXIES trống: cầu chì đếm theo địa chỉ kết nối TCP — chỉ đúng khi KHÔNG có proxy phía trước (local). Sau proxy Render = chặn mọi người (§3.2).',
    });
  }
  return {
    warnings,
    vars: {
      EDGE_PREFIX: prefix,
      EDGE_LISTEN: String(port),
      EDGE_UPSTREAM: String(upstream),
      EDGE_REAL_IP: realIpBlock(env),
      EDGE_IP_FUSE: fuse ? '1' : '0',
      EDGE_IP_RATE: String(clampInt(env, 'EDGE_IP_RATE')),
      EDGE_IP_BURST: String(clampInt(env, 'EDGE_IP_BURST')),
      EDGE_CONN_PER_IP: String(clampInt(env, 'EDGE_CONN_PER_IP')),
      HUB_DOCS_URL: docs,
      EDGE_ACCESS_LOG: accessLog,
      EDGE_SHUTDOWN_TIMEOUT: `${nginxShutdownSeconds(env)}s`,
    },
  };
}

/** `envsubst '${A} ${B}…'` với env CHỈ gồm các biến đó (+PATH để tìm lệnh). Còn sót `${EDGE_…}` -> lỗi. */
function renderTemplate(vars, { template = TEMPLATE, envsubst = 'envsubst' } = {}) {
  const shellFormat = EDGE_ENVSUBST_VARS.map((v) => '${' + v + '}').join(' ');
  const r = spawnSync(envsubst, [shellFormat], {
    input: fs.readFileSync(template, 'utf8'),
    env: { PATH: process.env.PATH || '/usr/bin:/bin', ...vars },
    encoding: 'utf8',
  });
  if (r.error) throw new Error(`không chạy được envsubst: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`envsubst lỗi: ${r.stderr}`);
  const left = r.stdout.match(/\$\{[A-Z_]+\}/g);
  if (left) throw new Error(`template còn biến chưa thay: ${[...new Set(left)].join(', ')}`);
  return r.stdout;
}

/** Dựng thư mục làm việc + file cấu hình. Trả đường dẫn và lệnh chạy nginx (foreground). */
function prepareEdge(env, { listenPort, upstream, prefix = env.EDGE_PREFIX || '/tmp/edge-nginx', envsubst, accessLog } = {}) {
  const { vars, warnings } = edgeVars(env, { listenPort, upstream, prefix, accessLog });
  const conf = renderTemplate(vars, { envsubst });
  fs.mkdirSync(prefix, { recursive: true });
  const confPath = path.join(prefix, 'nginx.conf');
  fs.writeFileSync(confPath, conf);
  return {
    confPath,
    warnings,
    vars,
    cmd: env.EDGE_NGINX_BIN || 'nginx',
    args: ['-e', 'stderr', '-p', prefix, '-c', confPath, '-g', 'daemon off;'],
  };
}

/** Regex sourceKey của location /hooks/* — [EG:T3] đọc từ template, không chép lại. */
function sourceKeyLocationRegex(template = fs.readFileSync(TEMPLATE, 'utf8')) {
  const lines = template.split('\n');
  const i = lines.findIndex((l) => l.includes('EG:SOURCE_KEY_RE'));
  const m = i >= 0 ? /location ~ "([^"]+)"/.exec(lines[i + 1] ?? '') : null;
  if (!m) throw new Error('không tìm thấy location regex /hooks/* (dòng sau "EG:SOURCE_KEY_RE")');
  return new RegExp(m[1]);
}

function main() {
  const cmd = process.argv[2];
  if (cmd !== 'render') {
    process.stderr.write('dùng: node docker/nginx/edge.js render\n');
    process.exit(2);
  }
  const env = process.env;
  const out = prepareEdge(env, { listenPort: env.PORT || '8080', upstream: env.EDGE_UPSTREAM || 'hub-api:4000' });
  for (const w of out.warnings) process.stderr.write(`${JSON.stringify({ proc: 'edge', level: w.level, msg: w.msg })}\n`);
  process.stdout.write(`${out.confPath}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${JSON.stringify({ proc: 'edge', level: 60, msg: `cấu hình nginx lỗi: ${err.message}` })}\n`);
    process.exit(1);
  }
}

module.exports = { EDGE_ENVSUBST_VARS, TEMPLATE, edgeVars, renderTemplate, prepareEdge, sourceKeyLocationRegex, realIpBlock, on, edgeDrainMs, nginxShutdownSeconds };
