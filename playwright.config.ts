import { defineConfig, devices } from "@playwright/test"

// Headless smoke test for the WebGL game. The bundled Chromium renders WebGL via
// SwiftShader (software) so it runs on a GPU-less CI box; the flags below opt
// into that path. The test just boots the built app, enters a level and checks
// the 3D canvas comes up with a live WebGL context and no fatal errors.
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"],
        },
      },
    },
  ],
  webServer: {
    command: "pnpm start",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
