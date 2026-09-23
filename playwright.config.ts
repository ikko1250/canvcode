import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: { baseURL: 'http://127.0.0.1:4179', viewport: { width: 1000, height: 800 }, trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'npm run dev -w @canvcode/web -- --host 127.0.0.1 --port 4179 --strictPort',
    url: 'http://127.0.0.1:4179/canvas-input-test.html',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
