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
  'EDGE_HOOKS_IP_LIMITS',
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

/**
 * LH3 (ADR-217, REVIEW-LH3 TB-1): lưới hứng bật = CATCHNET_FORWARD_SECRET có ít nhất một giá trị ≥ 32 ký tự (CÙNG luật
 * với hub-api `catchnetSecrets`). Chỉ đọc độ dài — giá trị secret không bao giờ vào cấu hình nginx.
 */
function catchnetOn(env) {
  return String(env.CATCHNET_FORWARD_SECRET || '')
    .split(',')
    .slice(0, 2)
    .some((s) => s.trim().length >= 32);
}

function clampInt(env, name) {
  const { def, min, max } = LIMITS[name];
  const raw = env[name];
  const n = raw === undefined || String(raw).trim() === '' ? def : parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * IPv6 (cả dạng đuôi chấm `::ffff:1.2.3.4`) -> 128 bit (BigInt); sai khuôn -> null. Không phụ thuộc thư viện ngoài
 * (file này chạy trong image trước khi có node_modules của app). Cùng thuật toán với apps/hub-api/src/trust-proxy.ts.
 */
function ipv6Bits(addr) {
  let a = addr;
  const dotted = /^(.*:)([^:]+\.[^:]+)$/.exec(a);
  if (dotted) {
    if (!IPV4.test(dotted[2])) return null;
    const o = dotted[2].split('.').map(Number);
    a = `${dotted[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const part = (x) => (x === '' ? [] : x.split(':'));
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const words = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (words.some((w) => !/^[0-9A-Fa-f]{1,4}$/.test(w))) return null;
  return words.reduce((acc, w) => (acc << 16n) | BigInt(parseInt(w, 16)), 0n);
}

const MAPPED_NET = 0xffffn << 32n; // ::ffff:0:0/96 — không gian IPv4-mapped

/**
 * Số bit prefix "hiệu dụng" của một CIDR khi so với luật dải rộng (review EG1 lượt 3, TB-1). proxy-addr (express) quy
 * subnet IPv4-mapped về IPv4 với `prefix - 96`, và so một peer IPv4 với subnet IPv6 bằng dạng mapped của nó, nên:
 * - IPv6 chứa TRỌN ::ffff:0:0/96 (vd `::/16`, `::ffff:0:0/96`) = tin mọi IPv4 -> `{ v4: 0 }`;
 * - IPv6 nằm trong ::ffff:0:0/96 với prefix p -> IPv4 /(p-96);
 * - còn lại giữ nguyên họ địa chỉ.
 */
function effectivePrefix(addr, prefix) {
  if (IPV4.test(addr)) return { v4: prefix ?? 32 };
  const bits = ipv6Bits(addr);
  const p = prefix ?? 128;
  if (bits === null) return null;
  const mask = (n) => (n === 0 ? 0n : ((1n << BigInt(n)) - 1n) << BigInt(128 - n));
  if (p <= 96 && (bits & mask(p)) === (MAPPED_NET & mask(p))) return { v4: 0 };
  if (p > 96 && (bits & mask(96)) === MAPPED_NET) return { v4: p - 96 };
  return { v6: p };
}

/** Một phần tử của EDGE_TRUSTED_PROXIES: IPv4/IPv6, có thể kèm /prefix. Sai khuôn -> null (gọi hàm sẽ ném lỗi). */
function normalizeCidr(item) {
  const [addr, prefix, extra] = item.split('/');
  if (extra !== undefined) return null;
  const v4 = IPV4.test(addr);
  const v6 = !v4 && addr.includes(':') && ipv6Bits(addr) !== null;
  if (!v4 && !v6) return null;
  if (prefix !== undefined) {
    if (!/^\d{1,3}$/.test(prefix)) return null;
    const p = Number(prefix);
    if (p > (v4 ? 32 : 128)) return null;
  }
  return item;
}

/**
 * Dải coi là "quá rộng" để tin đệ quy: /0, IPv4 ngắn hơn /8, IPv6 ngắn hơn /16 — sau khi quy dạng IPv4-mapped về IPv4
 * (`::ffff:0:0/96` = `0.0.0.0/0`, `::/16` chứa trọn không gian mapped). Địa chỉ đơn lẻ không bao giờ rộng.
 */
function tooWide(item) {
  const [addr, prefix] = item.split('/');
  if (prefix === undefined) return false;
  const eff = effectivePrefix(addr, Number(prefix));
  return eff === null || (eff.v4 !== undefined ? eff.v4 < 8 : eff.v6 < 16);
}

/** EDGE_TRUSTED_PROXIES -> danh sách phần tử. Chỉ gồm dấu phân cách (`" , "`) = trống (review EG1 lượt 3, Thấp-1). */
function trustedItems(env) {
  return String(env.EDGE_TRUSTED_PROXIES ?? '').split(/[\s,]+/).filter(Boolean);
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
  const items = trustedItems(env);
  if (!items.length) return '    # EDGE_TRUSTED_PROXIES trống: $remote_addr = địa chỉ kết nối TCP (không tin X-Forwarded-For).';
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
function edgeVars(env, { listenPort, upstream, prefix, accessLog = '/dev/stdout', requireTrusted = false }) {
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
  const trusted = trustedItems(env).length > 0;
  /** @type {{level:number, msg:string}[]} */
  const warnings = [];
  // Review EG1 #3 + spec EG D11: hub-all (EDGE_NGINX=1, `requireTrusted`) hoặc chạy trên Render (env RENDER) thì mọi kết
  // nối tới nginx đến từ proxy phía trước. Không khai proxy tin cậy = req.ip của MỌI người là IP proxy: rate limit đăng
  // nhập chung một xô, limit_conn thành trần chung, hộp phạt EG2 phạt tất cả. Từ chối khởi động, trừ khi cố ý vượt bằng
  // EDGE_ALLOW_NO_REAL_IP=1 (cảnh báo level 50). Service `edge` của compose (không proxy phía trước) không bị áp.
  if (!trusted && (requireTrusted || env.RENDER)) {
    if (!on(env.EDGE_ALLOW_NO_REAL_IP)) {
      throw new Error(
        'EDGE_NGINX cần EDGE_TRUSTED_PROXIES (Render: 0.0.0.0/0,::/0 + EDGE_REAL_IP_RECURSIVE=off, xem DEPLOYMENT §3.6). Trống = mọi request mang IP của proxy phía trước. Cố ý chạy vậy (không có proxy phía trước): EDGE_ALLOW_NO_REAL_IP=1',
      );
    }
    warnings.push({ level: 50, msg: 'EDGE_ALLOW_NO_REAL_IP=1: nginx KHÔNG đọc IP thật — nếu có proxy phía trước (Render) thì req.ip của mọi người là IP proxy (rate limit IP, limit_conn, hộp phạt dùng chung một khoá).' });
  }
  if (fuse && !trusted) {
    warnings.push({
      level: env.RENDER ? 50 : 40,
      msg: 'EDGE_IP_FUSE=1 nhưng EDGE_TRUSTED_PROXIES trống: cầu chì đếm theo địa chỉ kết nối TCP — chỉ đúng khi KHÔNG có proxy phía trước (local). Sau proxy Render = chặn mọi người (§3.2).',
    });
  }
  // LH3 (TB-1): lưới bật -> /hooks/* đi qua IP egress Cloudflare. nginx không kiểm được chữ ký lưới, nên KHÔNG tin
  // x-catchnet-client-ip và KHÔNG khoá theo IP kết nối ở /hooks/* (khoá chung cả lưới): tắt cầu chì + limit_conn của
  // /hooks/*. Giới hạn theo IP đã ký = cổng phạt hub-api. /v1/p/* giữ cầu chì.
  const catchnet = catchnetOn(env);
  if (catchnet && fuse) {
    warnings.push({
      level: 50,
      msg: 'EDGE_IP_FUSE=1 + lưới hứng bật (CATCHNET_FORWARD_SECRET): cầu chì và limit_conn theo IP của nginx TẮT cho /hooks/* (IP kết nối là IP Cloudflare, nginx không kiểm được chữ ký lưới). /v1/p/* vẫn có cầu chì; /hooks/* chỉ còn cổng phạt theo IP đã ký của hub-api (ADR-217).',
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
      EDGE_HOOKS_IP_LIMITS: catchnet ? '0' : '1',
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
function prepareEdge(env, { listenPort, upstream, prefix = env.EDGE_PREFIX || '/tmp/edge-nginx', envsubst, accessLog, requireTrusted } = {}) {
  const { vars, warnings } = edgeVars(env, { listenPort, upstream, prefix, accessLog, requireTrusted });
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

module.exports = { EDGE_ENVSUBST_VARS, TEMPLATE, catchnetOn, edgeVars, renderTemplate, prepareEdge, sourceKeyLocationRegex, realIpBlock, on, edgeDrainMs, nginxShutdownSeconds, tooWide };
