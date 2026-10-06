// e2e: настоящий Chromium (Playwright) против локальных стендов —
// PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers (или BROWSER_WORKER_CHROMIUM_PATH).
// Без браузера наборы пропускаются с пометкой (в CI — падают, см. test/e2e).
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/e2e/**/*.e2e.spec.ts'],
  testTimeout: 120000,
};
