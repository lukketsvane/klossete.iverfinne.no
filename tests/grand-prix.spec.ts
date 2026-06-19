import { test, expect } from "@playwright/test"

// Boot the Grand Prix racing module and confirm the WebGL scene comes up and
// the can actually starts rolling on input, with no fatal page/console errors.
test("grand prix boots, the can rolls without errors", async ({ page }) => {
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

  await page.goto("/grand-prix")

  const canvas = page.locator("canvas").first()
  await expect(canvas).toBeVisible({ timeout: 30_000 })

  const gl = await canvas.evaluate((el: HTMLCanvasElement) => {
    const ctx = el.getContext("webgl2") || el.getContext("webgl")
    return { ok: !!ctx, w: el.width, h: el.height }
  })
  expect(gl.ok, "canvas has a WebGL context").toBeTruthy()
  expect(gl.w).toBeGreaterThan(0)
  expect(gl.h).toBeGreaterThan(0)

  // let the scene settle (the GLB + first frames), then press-and-hold
  // dead-centre to start and roll straight down the course.
  await page.waitForTimeout(1500)
  const box = await canvas.boundingBox()
  expect(box, "canvas is laid out").not.toBeNull()
  await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.6)
  await page.mouse.down()
  await page.waitForTimeout(5000)

  // the progress pill should have advanced past 0 once the can is moving
  const progress = page.getByTestId("gp-progress")
  await expect
    .poll(async () => parseInt((await progress.textContent()) || "0", 10), { timeout: 12000 })
    .toBeGreaterThan(0)
  await page.mouse.up()

  expect(fatal, `fatal errors:\n${fatal.join("\n")}`).toHaveLength(0)

  expect(fatal, `fatal errors:\n${fatal.join("\n")}`).toHaveLength(0)
})
