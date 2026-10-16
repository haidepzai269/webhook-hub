/**
 * D1 giả cho test L0: node:sqlite (SQLite thật, cùng engine với D1) + đúng schema `migrations/0001_init.sql`
 * (gồm trigger bộ đếm). API khớp phần D1 mà Worker dùng (`src/d1.ts`). `failOn` để mô phỏng D1 lỗi ([LH:T6]).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { D1Database, D1PreparedStatement, D1Result } from '../src/d1';

export interface FakeD1 extends D1Database {
  raw: DatabaseSync;
  /** Câu SQL khớp regex này ném lỗi (mô phỏng D1 lỗi / quota). */
  failOn: RegExp | null;
}

const SCHEMA = readFileSync(join(__dirname, '..', 'migrations', '0001_init.sql'), 'utf8');

export function fakeD1(): FakeD1 {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA);
  const db: FakeD1 = {
    raw,
    failOn: null,
    prepare(d1sql: string): D1PreparedStatement {
      // node:sqlite không bind được `?NNN` theo số (D1 thì được) -> đổi thành `?` tuần tự, nhân bản tham số theo thứ tự xuất hiện.
      const order: number[] = [];
      const sql = d1sql.replace(/\?(\d+)/g, (_m, n: string) => {
        order.push(Number(n) - 1);
        return '?';
      });
      let params: unknown[] = [];
      const check = () => {
        if (db.failOn && db.failOn.test(sql)) throw new Error('D1_ERROR: giả lập lỗi');
      };
      const stmt: D1PreparedStatement & { _exec(): D1Result } = {
        bind(...values: unknown[]) {
          const vals = values.map((v) => (v === undefined ? null : v));
          params = order.length ? order.map((i) => vals[i]) : vals;
          return stmt;
        },
        async first<T>() {
          check();
          return ((raw.prepare(sql).get(...(params as never[])) as T) ?? null) as T | null;
        },
        async all<T>() {
          check();
          return { results: raw.prepare(sql).all(...(params as never[])) as T[], success: true, meta: { changes: 0 } };
        },
        async run() {
          return stmt._exec();
        },
        _exec() {
          check();
          const s = raw.prepare(sql);
          if (/^\s*select/i.test(sql)) return { results: s.all(...(params as never[])) as Record<string, unknown>[], success: true, meta: { changes: 0 } };
          const r = s.run(...(params as never[]));
          return { results: [], success: true, meta: { changes: Number(r.changes) } };
        },
      };
      return stmt;
    },
    async batch(statements: D1PreparedStatement[]) {
      raw.exec('BEGIN');
      try {
        const out = statements.map((s) => (s as unknown as { _exec(): D1Result })._exec());
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
  return db;
}

export function count(db: FakeD1, table: string): number {
  return Number((db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}
