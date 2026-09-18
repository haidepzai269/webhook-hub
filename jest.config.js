module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  collectCoverageFrom: ['**/*.(t|j)s'],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@hub/common(.*)$': '<rootDir>/libs/common/src$1',
    '^@hub/crypto(.*)$': '<rootDir>/libs/crypto/src$1',
    '^@hub/messaging(.*)$': '<rootDir>/libs/messaging/src$1',
    '^@hub/database(.*)$': '<rootDir>/libs/database/src$1',
    '^@hub/providers(.*)$': '<rootDir>/libs/providers/src$1',
  },
};
