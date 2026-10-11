const { defineConfig, devices } = require("@playwright/test");
const remote = process.env.SANDBOX_URL;
module.exports = defineConfig({
  testDir: "./tests",
  workers: process.env.ASSIST_SANDBOX_VOICE_QA === "1" ? 1 : undefined,
  timeout: 60000,
  retries: 1,
  reporter: [
    ["list"],
    ["html", { open: "never" }],
    ["./qa/playwright-reporter.cjs"],
  ],
  use: {
    baseURL: remote || "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
  webServer: remote
    ? undefined
    : {
        command: "npm start",
        url: "http://127.0.0.1:4173",
        reuseExistingServer: !process.env.CI,
      },
});
