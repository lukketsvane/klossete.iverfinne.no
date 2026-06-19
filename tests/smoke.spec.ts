import { test, expect } from "@playwright/test"

// Boot the built app, start the race and confirm the WebGL game actually comes
// up: a visible canvas, a live WebGL context, and no fatal page/console errors.
test("grand prix boots and renders a live WebGL canvas without errors", async ({ page }) => {
  const fatal: string[] = []
  page.on("pageerror", (e) => fatal.push(`pageerror: ${e.message}`))

  const ALLOW_404 = /_vercel\/insights|\/favicon\.ico/
  page.on("response", (r) => {
    if (r.status() >= 400 && !ALLOW_404.test(r.url())) fatal.push(`http ${r.status()}: ${r.url()}`)
  })
  page.on("console", (m) => {
    if (m.type() !== "error") return
    const t = m.text()
    if (/Failed to load resource|React DevTools|net::ERR/i.test(t)) return
    fatal.push(`console: ${t}`)
  })

  await page.goto("/")

  // the 3D canvas mounts immediately on the ready screen
  const canvas = page.locator("canvas").first()
  await expect(canvas).toBeVisible({ timeout: 30_000 })

  // start the race
  const start = page.getByRole("button", { name: "start løpet" })
  await expect(start).toBeVisible({ timeout: 30_000 })
  await start.click()

  const gl = await canvas.evaluate((el: HTMLCanvasElement) => {
    const ctx = el.getContext("webgl2") || el.getContext("webgl")
    return { ok: !!ctx, w: el.width, h: el.height }
  })
  expect(gl.ok, "canvas has a WebGL context").toBeTruthy()
  expect(gl.w).toBeGreaterThan(0)
  expect(gl.h).toBeGreaterThan(0)

  await page.waitForTimeout(2500)
  expect(fatal, `fatal errors:\n${fatal.join("\n")}`).toHaveLength(0)
})
