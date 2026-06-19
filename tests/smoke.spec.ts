import { test, expect } from "@playwright/test"

// Boot the built app, enter the first level and confirm the WebGL game actually
// comes up: a visible canvas, a live WebGL context, and no fatal page/console
// errors. This is the headless røyktest that CI couldn't run before – it catches
// crashes that a type-check or lint can't (a bad shader, a null in a room, etc.).
test("title boots, level renders a live WebGL canvas without errors", async ({ page }) => {
  const fatal: string[] = []
  page.on("pageerror", (e) => fatal.push(`pageerror: ${e.message}`))

  // Asset 404s surface as generic "Failed to load resource" console errors with
  // no URL, so track them by response instead. Vercel Analytics only exists on a
  // real Vercel deploy, so its absence locally/in CI is expected, not a failure.
  const ALLOW_404 = /_vercel\/insights|\/favicon\.ico/
  page.on("response", (r) => {
    if (r.status() >= 400 && !ALLOW_404.test(r.url())) fatal.push(`http ${r.status()}: ${r.url()}`)
  })
  page.on("console", (m) => {
    if (m.type() !== "error") return
    const t = m.text()
    // 404s are covered by the response listener; drop the URL-less console echo
    if (/Failed to load resource|React DevTools|net::ERR/i.test(t)) return
    fatal.push(`console: ${t}`)
  })

  await page.goto("/")

  // title screen → start the game
  const start = page.getByRole("button", { name: "start spelet" })
  await expect(start).toBeVisible({ timeout: 30_000 })
  await start.click()

  // the 3D canvas mounts once a level is open
  const canvas = page.locator("canvas").first()
  await expect(canvas).toBeVisible({ timeout: 30_000 })

  // a real, non-zero-sized WebGL context is up
  const gl = await canvas.evaluate((el: HTMLCanvasElement) => {
    const ctx = el.getContext("webgl2") || el.getContext("webgl")
    return { ok: !!ctx, w: el.width, h: el.height }
  })
  expect(gl.ok, "canvas has a WebGL context").toBeTruthy()
  expect(gl.w).toBeGreaterThan(0)
  expect(gl.h).toBeGreaterThan(0)

  // let a few frames run, then assert nothing blew up
  await page.waitForTimeout(2500)
  expect(fatal, `fatal errors:\n${fatal.join("\n")}`).toHaveLength(0)
})
