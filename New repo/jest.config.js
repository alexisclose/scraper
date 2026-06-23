// ESM-mode Jest. Run via `npm test` (the script sets --experimental-vm-modules).
export default {
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.js', '**/*.test.js'],
  // Auto-created Chrome CDP profiles (.browser-profiles/) bundle extension
  // *.test.js files that Jest would otherwise try to run. Keep test discovery
  // to our own sources.
  testPathIgnorePatterns: ['/node_modules/', '/.browser-profiles/', '/data/'],
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
