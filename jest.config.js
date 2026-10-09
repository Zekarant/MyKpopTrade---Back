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
  // Sur une machine chargée, une requête MongoDB en mémoire dépasse parfois les 5 s par défaut.
  testTimeout: 15000,
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/\\.claude/'],
  modulePathIgnorePatterns: ['/\\.claude/'],
  // Couverture mesurée sur tout le code applicatif, y compris les fichiers
  // qu'aucun test n'importe (sinon ils n'apparaissent pas et le chiffre ment).
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/__tests__/**',
    '!src/tests/**',
    '!src/scripts/**',
    '!src/types/**',
    '!src/**/*.d.ts'
  ],
  moduleNameMapper: {
    '^isomorphic-dompurify$': '<rootDir>/src/tests/__mocks__/isomorphic-dompurify.ts'
  }
};
