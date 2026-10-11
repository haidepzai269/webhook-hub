#!/usr/bin/env node
'use strict';
/**
 * DX3: `npx hub listen …` / `npx hub trigger …` (SPEC-dev-experience §4). Không phụ thuộc ngoài.
 * Ưu tiên bản đã build (`dist/cli.js`); trong monorepo chưa build thì chạy thẳng `src/cli.ts` qua ts-node +
 * tsconfig-paths (devDependency gốc) — dev không phải nhớ bước build.
 */
const fs = require('fs');
const path = require('path');

function loadCli() {
  const built = path.join(__dirname, '..', 'dist', 'cli.js');
  if (fs.existsSync(built)) return require(built);
  const root = path.join(__dirname, '..', '..', '..');
  process.env.TS_NODE_PROJECT = process.env.TS_NODE_PROJECT || path.join(root, 'tsconfig.base.json');
  try {
    require('ts-node').register({ transpileOnly: true, project: process.env.TS_NODE_PROJECT });
    require('tsconfig-paths').register({ baseUrl: root, paths: require(path.join(root, 'tsconfig.base.json')).compilerOptions.paths });
  } catch {
    process.stderr.write('hub: cannot load the CLI. Run `npm run build -w libs/hub-sdk` (and build:libs) first.\n');
    process.exit(2);
  }
  return require(path.join(__dirname, '..', 'src', 'cli.ts'));
}

const { runCli } = loadCli();
const ac = new AbortController();
let interrupted = 0;
process.on('SIGINT', () => {
  // Lần 1: dừng êm, in tổng kết (cursor để resume). Lần 2: thoát ngay.
  if (interrupted++) process.exit(130);
  ac.abort();
});
runCli(process.argv.slice(2), {
  out: (s) => process.stdout.write(s + '\n'),
  err: (s) => process.stderr.write(s + '\n'),
  env: process.env,
  signal: ac.signal,
}).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`hub: unexpected error (${(e && e.name) || 'Error'})\n`);
    process.exit(1);
  },
);
