import { defineConfig, devices } from '@playwright/test';

/**
 * E2E виджета в песочнице (W1): Chromium из /opt/pw-browsers
 * (PLAYWRIGHT_BROWSERS_PATH; ревизия 1194 = @playwright/test 1.56.1).
 *
 * Стенд — `e2e/stand/server.ts`: origin виджета localhost:5181 (dist/v1 +
 * HTML iframe с CSP + мок API W2, или прокси на sites-backend при
 * WIDGET_E2E_BACKEND) и «сайты заказчика» *.localhost:5182. Перед e2e —
 * `npm run build` (globalSetup проверяет dist).
 *
 * Эмуляция мобильных (Pixel 7) — это Chromium с вьюпортом и touch,
 * НЕ iOS Safari и не Android Chrome: живые устройства — владелец (контракт Э2 §8).
 * Один воркер: мок держит общее состояние (часы, задержка токенов).
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 45_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  globalSetup: './e2e/global-setup.ts',
  // В CI ещё и `github`: упавший e2e виден аннотацией проверки (публичный
  // API без входа) — иначе причину видно только в логах джобы (CI d19fddf).
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx tsx e2e/stand/server.ts',
    url: 'http://localhost:5181/__mock/log',
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    timeout: 30_000,
  },
  projects: [
    {
      name: 'desktop',
      testIgnore: /\.mobile\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile',
      testMatch: /\.mobile\.spec\.ts$/,
      use: { ...devices['Pixel 7'] },
    },
  ],
});
