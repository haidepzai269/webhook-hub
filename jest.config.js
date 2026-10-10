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
  // VF7: worktree của agent (.claude/worktrees/*) và của probe (VF6) nằm DƯỚI thư mục repo → haste map thấy hai
  // bản @hub/* và mọi suite import @hub chết ("several different files … provide a module"). Bỏ qua chúng.
  modulePathIgnorePatterns: ['<rootDir>/.claude/', '<rootDir>/dist/'],
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/.claude/'],
  moduleNameMapper: {
    '^@hub/common(.*)$': '<rootDir>/libs/common/src$1',
    '^@hub/crypto(.*)$': '<rootDir>/libs/crypto/src$1',
    '^@hub/messaging(.*)$': '<rootDir>/libs/messaging/src$1',
    '^@hub/database(.*)$': '<rootDir>/libs/database/src$1',
    '^@hub/providers(.*)$': '<rootDir>/libs/providers/src$1',
  },
};
