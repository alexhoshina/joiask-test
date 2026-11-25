import { randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';
import { adminCredentials, baseURL, port } from './tests/e2e/environment.js';

// Each test invocation owns its D1, R2, and Durable Object state. Playwright
// shuts Wrangler down before this process exits, including on test failures.
const state = `.wrangler/e2e-${randomUUID()}`;
const stateDirectory = new URL('./' + state + '/', import.meta.url);
process.once('exit', () => rmSync(stateDirectory, { recursive: true, force: true, maxRetries: 5 }));
// Selecting the public template prevents Wrangler from loading the developer's
// .dev.vars. The required secrets come from webServer.env.
const local = `--local --persist-to ${state} --env-file .dev.vars.example`;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  // Tests modify shared site settings; keep the disposable database serial.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: [
      `npm exec --offline -- wrangler d1 migrations apply DB ${local} --config wrangler.jsonc`,
      `npm exec --offline -- wrangler dev ${local} --config dist/server/wrangler.json --ip 127.0.0.1 --port ${port}` +
        ` --var JOIASK_INITIAL_ADMIN_USERNAME:${adminCredentials.username} --var JOIASK_INITIAL_ADMIN_PASSWORD:${adminCredentials.password}`,
    ].join(' && '),
    env: {
      SESSION_SECRET: randomBytes(32).toString('hex'),
      SETTINGS_KEY: randomBytes(32).toString('hex'),
    },
    url: `${baseURL}/api/config`,
    timeout: 180_000,
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
  },
});
