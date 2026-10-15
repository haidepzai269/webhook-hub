import { defineConfig } from 'vitest/config';

// L0 chạy trên Node (D1 giả bằng node:sqlite, fetch giả). Chạy workerd thật (wrangler dev --local) là việc máy
// công ty (LH2-VIEC-MAY-CONG-TY.md), không chạy trên máy dev yếu RAM (H10).
export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    pool: 'threads',
    poolOptions: { threads: { maxThreads: 2, minThreads: 1 } },
  },
});
