import { defineConfig, devices } from '@playwright/test'

/**
 * Smoke coverage only — §12: "Playwright covers two or three smoke flows only,
 * everything else above is headless." The unit suite owns behaviour; these tests
 * exist to catch the failures a headless suite structurally cannot see: the app
 * not booting, the canvases not sizing, a download never firing.
 *
 * The DPR is pinned because §5.3 caps the backing store at `min(dpr, 2)` and the
 * board snaps coordinates to device pixels — a CI machine reporting 1.25 would
 * produce different pixels than a developer's 2.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:5174',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
    },
  ],
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 5174 --strictPort',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
  },
})
