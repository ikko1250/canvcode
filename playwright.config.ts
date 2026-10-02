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
  // テストはサーバーの応答を page.route などで差し替える。差し替えていない API が本物のサーバー（8787 の本番など）に
  // 届いてデータを書き換えないよう、開発サーバーの /api のプロキシ先を、誰も待ち受けていないポートにする（vite.config.ts）。
  // すでに動いている開発サーバー（本物のサーバーにつながっているかもしれない）は使わない
  webServer: {
    command: 'npm run dev -w @canvcode/web -- --host 127.0.0.1 --port 4179 --strictPort',
    url: 'http://127.0.0.1:4179/canvas-input-test.html',
    env: { CANVCODE_API_TARGET: 'http://127.0.0.1:9' },
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
