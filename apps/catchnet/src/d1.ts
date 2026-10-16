/**
 * Kiểu tối thiểu của D1 mà Worker dùng (khỏi kéo @cloudflare/workers-types). Khớp API runtime Workers:
 * https://developers.cloudflare.com/d1/worker-api/ — test L0 cài bản giả trên node:sqlite (test/d1-fake.ts).
 */
export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: { changes: number; [k: string]: unknown };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  /** Một transaction: lỗi một câu -> rollback cả lô. */
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}
