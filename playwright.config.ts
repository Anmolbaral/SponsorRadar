import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT ?? "3000");
const externalBaseURL = process.env.PLAYWRIGHT_BASE_URL?.trim();
const allowRemoteMutations =
  process.env.PLAYWRIGHT_ALLOW_REMOTE_MUTATIONS === "true";
const baseURL = externalBaseURL ?? `http://localhost:${port}`;
const httpUsername =
  process.env.PLAYWRIGHT_HTTP_USERNAME?.trim() ??
  process.env.SPONSOR_RADAR_BASIC_AUTH_USER?.trim();
const httpPassword =
  process.env.PLAYWRIGHT_HTTP_PASSWORD ??
  process.env.SPONSOR_RADAR_BASIC_AUTH_PASSWORD;
const serverMode = process.env.PLAYWRIGHT_SERVER_MODE ?? "development";
const e2eDataDirectory =
  process.env.PLAYWRIGHT_DATA_DIR?.trim() ??
  `.data/sponsor-radar-playwright-${port}-${
    process.env.SPONSOR_RADAR_RUN_CREDIT_LIMIT?.trim() ?? "160"
  }`;
const serverCommand =
  serverMode === "production"
    ? `HOSTNAME=localhost PORT=${port} node .next/standalone/server.js`
    : `node_modules/.bin/next dev --hostname localhost --port ${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  grep:
    externalBaseURL && !allowRemoteMutations
      ? /production-safe/
      : undefined,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: "html",
  use: {
    baseURL,
    httpCredentials:
      httpUsername && httpPassword
        ? { username: httpUsername, password: httpPassword }
        : undefined,
    trace: "on-first-retry"
  },
  webServer: externalBaseURL
    ? undefined
    : {
        command: serverCommand,
        url: baseURL,
        env: {
          SPONSOR_RADAR_DATA_DIR: e2eDataDirectory,
          SPONSOR_RADAR_LLM_MODE: "fixture",
          UPRIVER_MODE: "fixture",
        },
        reuseExistingServer: !process.env.CI,
        timeout: 120_000
      },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chrome"
      }
    }
  ]
});
