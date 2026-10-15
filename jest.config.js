module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
  collectCoverageFrom: ['**/*.(t|j)s'],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
  // Máy dev 16GB sập khi `npx jest` trơn mở 11 worker (mặc định = số lõi − 1). Khoá 2 ngay trong config; cờ CLI
  // `--maxWorkers` vẫn thắng (verify/cli/run.ts truyền VERIFY_JEST_WORKERS=4 trên CI). Ghi đè không cần cờ:
  // JEST_MAX_WORKERS (hoặc VERIFY_JEST_WORKERS). Worker vượt 512MB khi rảnh thì bị thay (ts-jest rò bộ nhớ qua nhiều suite).
  maxWorkers: process.env.JEST_MAX_WORKERS || process.env.VERIFY_JEST_WORKERS || 2,
  workerIdleMemoryLimit: '512MB',
  // VF7: worktree của agent (.claude/worktrees/*) và của probe (VF6) nằm DƯỚI thư mục repo → haste map thấy hai
  // bản @hub/* và mọi suite import @hub chết ("several different files … provide a module"). Bỏ qua chúng.
  modulePathIgnorePatterns: ['<rootDir>/.claude/', '<rootDir>/dist/', '<rootDir>/apps/catchnet/'],
  // LH2 (H10): apps/catchnet là Worker NGOÀI workspaces, test bằng vitest của chính nó (job CI riêng) — jest gốc bỏ qua.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/.claude/', '<rootDir>/apps/catchnet/'],
  moduleNameMapper: {
    '^@hub/common(.*)$': '<rootDir>/libs/common/src$1',
    '^@hub/crypto(.*)$': '<rootDir>/libs/crypto/src$1',
    '^@hub/messaging(.*)$': '<rootDir>/libs/messaging/src$1',
    '^@hub/database(.*)$': '<rootDir>/libs/database/src$1',
    '^@hub/providers(.*)$': '<rootDir>/libs/providers/src$1',
    '^@hub/sdk(.*)$': '<rootDir>/libs/hub-sdk/src$1',
  },
};
