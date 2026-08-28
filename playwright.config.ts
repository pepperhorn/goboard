import { defineConfig, devices } from '@playwright/test'

/**
 * Smoke coverage only — §12: "Playwright covers six smoke flows — everything else
 * above is headless." The unit suite owns behaviour; these tests
 * exist to catch the failures a headless suite structurally cannot see: the app
 * not booting, the canvases not sizing, a download never firing.
 *
 * The DPR is pinned because §5.3 caps the backing store at `min(dpr, 2)` and the
 * board snaps coordinates to device pixels — a CI machine reporting 1.25 would
 * produce different pixels than a developer's 2.
 */
export default defineConfig({
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
      testDir: './e2e',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
    },
    {
      // §5.3's benchmark. Separate because it is slow, serial by nature (a parallel
      // worker on the same CPU is exactly the noise it must not measure), and read as
      // a number rather than a pass/fail.
      name: 'bench',
      testDir: './bench',
      fullyParallel: false,
      workers: 1,
      retries: 0,
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
