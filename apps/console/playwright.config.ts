import { defineConfig } from "@playwright/test";

// The console is tested against recorded API responses (e2e/fixtures), so it needs no backend.
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:4193" },
  webServer: {
    command: "pnpm build && pnpm preview",
    url: "http://127.0.0.1:4193",
    timeout: 120_000,
    reuseExistingServer: true,
  },
});
