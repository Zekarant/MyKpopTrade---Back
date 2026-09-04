/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts', '**/tests/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js'],
  rootDir: './',
  // Suite d'intégration lourde (mongodb-memory-server) : éviter la sursouscription CPU
  // qui provoque des timeouts de 5 s en faux négatif.
  maxWorkers: '50%',
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/\\.claude/'],
  modulePathIgnorePatterns: ['/\\.claude/'],
  moduleNameMapper: {
    '^isomorphic-dompurify$': '<rootDir>/src/tests/__mocks__/isomorphic-dompurify.ts'
  }
};
