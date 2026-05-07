// ESM-mode Jest. Run via `npm test` (the script sets --experimental-vm-modules).
export default {
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.js', '**/*.test.js'],
  transform: {},
  moduleFileExtensions: ['js', 'json'],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/index.js',
    '!src/commands/**',
  ],
  coverageDirectory: 'coverage',
  // Brand parsers may take a few seconds when fixtures are large.
  testTimeout: 15000,
};
