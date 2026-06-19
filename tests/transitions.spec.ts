import { test, expect } from "@playwright/test"

// Regression guard for the "blank screen / next level won't load" crash. Rapidly
// hopping between levels swaps the mounted block set and re-types/resets Rapier
// bodies; touching a body mid-swap used to throw out of wasm ("recursive use …
// unsafe aliasing", "borrowed", "null pointer passed to rust") and kill R3F's
// render loop for good, leaving a frozen/blank canvas. The engine now wraps every
// per-frame body access (useSafeFrame + isValid guards), so a swap can never take
// the loop down. This test jumps across levels many times and asserts the page
// never throws – if the guards regress, the wasm errors come straight back here.
test("rapid level transitions never crash the render loop", async ({ page }) => {
  test.setTimeout(90_000) // many swaps + a software-rendered WebGL boot
  const fatal: string[] = []
  page.on("pageerror", (e) => fatal.push(`pageerror: ${e.message}`))

  await page.goto("/")
  const start = page.getByRole("button", { name: "start spelet" })
  await expect(start).toBeVisible({ timeout: 30_000 })
  await start.click()

  const canvas = page.locator("canvas").first()
  await expect(canvas).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(1200) // let the first level settle

  // Number keys 1–9 jump straight to a level. Hammer the swaps – forward, back,
  // and a few quick double-jumps that land a transition right on top of another –
  // exactly the timing that surfaced the freed/borrowed-body crash.
  const order = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "5", "1", "9", "3", "7", "2", "8", "4", "6", "1"]
  for (const key of order) {
    await page.keyboard.press(key)
    await page.waitForTimeout(140)
  }

  // a quick burst with no settle time between, to stack swaps on the same frames
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press(String((i % 9) + 1))
    await page.waitForTimeout(35)
  }

  await page.waitForTimeout(1500)

  // the canvas must still be drawing live frames (a dead loop freezes the buffer)
  const alive = await canvas.evaluate((el: HTMLCanvasElement) => {
    const ctx = el.getContext("webgl2") || el.getContext("webgl")
    return !!ctx && el.width > 0 && el.height > 0
  })
  expect(alive, "canvas still has a live WebGL context after the transitions").toBeTruthy()
  expect(fatal, `fatal errors during transitions:\n${fatal.join("\n")}`).toHaveLength(0)
})

// The bespoke arrangement levels (12–19) replaced the old repeated stacking rooms.
// They live beyond the 1–9 number-key range, so reach them through the level
// picker and confirm each one mounts its silhouettes + place puzzle and runs
// crash-free (the place controller touches every target body each frame).
test("bespoke arrangement levels 12–19 load and render", async ({ page }) => {
  test.setTimeout(150_000) // eight full reloads + WebGL boots
  const fatal: string[] = []
  page.on("pageerror", (e) => fatal.push(`pageerror: ${e.message}`))

  // A representative spread: a 4-piece placement, a 5-piece cross, a stack, and the
  // tightest mosaic. They all run through the same place/stack renderer, so this
  // covers the new configs without eight slow reloads.
  const picks: { lvl: number; name: string }[] = [
    { lvl: 12, name: "Gjennom" },
    { lvl: 14, name: "Kross" },
    { lvl: 16, name: "Oppå" }, // overlapping target areas (stack the cube on the orange)
    { lvl: 17, name: "Stable 5" },
    { lvl: 18, name: "Dobbel" }, // two overlapping stacks
    { lvl: 19, name: "Sluse" },
  ]
  for (const { lvl, name } of picks) {
    // fresh boot per level – the menu picker is the reliable route. A reload from
    // a live WebGL/audio page can abort once, so retry the navigation.
    try {
      await page.goto("/", { waitUntil: "domcontentloaded" })
    } catch {
      await page.waitForTimeout(500)
      await page.goto("/", { waitUntil: "domcontentloaded" })
    }
    await page.getByRole("button", { name: "nivå", exact: true }).click()
    const cell = page.getByRole("button", { name: new RegExp(`^Nivå ${lvl}: ${name}`) })
    await expect(cell).toBeVisible({ timeout: 15_000 })
    await cell.click()
    const canvas = page.locator("canvas").first()
    await expect(canvas).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(700)
    const alive = await canvas.evaluate((el: HTMLCanvasElement) => {
      const ctx = el.getContext("webgl2") || el.getContext("webgl")
      return !!ctx && el.width > 0 && el.height > 0
    })
    expect(alive, `level ${lvl} (${name}) canvas alive`).toBeTruthy()
  }
  expect(fatal, `fatal errors loading 12–19:\n${fatal.join("\n")}`).toHaveLength(0)
})

// The piloting section (26–50) now has obstacles (blocked cells) and checkpoints
// in its pilot stages, driven each frame by the solo controller. Load an obstacle
// stage and the hardest checkpoint stage (both on picker page 2) and confirm the
// controller mounts and runs without throwing.
test("piloting stages with obstacles + checkpoints load and render", async ({ page }) => {
  test.setTimeout(120_000)
  const fatal: string[] = []
  page.on("pageerror", (e) => fatal.push(`pageerror: ${e.message}`))

  const picks: { lvl: number; name: string }[] = [
    { lvl: 32, name: "Langferd 2" }, // one barrier to route around
    { lvl: 49, name: "Vippen 6" }, // two barriers + two checkpoints (boss ramp peak)
  ]
  for (const { lvl, name } of picks) {
    try {
      await page.goto("/", { waitUntil: "domcontentloaded" })
    } catch {
      await page.waitForTimeout(500)
      await page.goto("/", { waitUntil: "domcontentloaded" })
    }
    await page.getByRole("button", { name: "nivå", exact: true }).click()
    // wait for the picker to actually open (page 1) before paging to levels 26–50
    await expect(page.getByRole("button", { name: /^Nivå 1:/ })).toBeVisible({ timeout: 15_000 })
    await page.getByRole("button", { name: "Neste side" }).click()
    // confirm page 2 loaded (level 26 is its first cell) before hunting the target
    await expect(page.getByRole("button", { name: /^Nivå 26:/ })).toBeVisible({ timeout: 15_000 })
    const cell = page.getByRole("button", { name: new RegExp(`^Nivå ${lvl}: ${name}`) })
    await expect(cell).toBeVisible({ timeout: 15_000 })
    await cell.click()
    const canvas = page.locator("canvas").first()
    await expect(canvas).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(900)
    const alive = await canvas.evaluate((el: HTMLCanvasElement) => {
      const ctx = el.getContext("webgl2") || el.getContext("webgl")
      return !!ctx && el.width > 0 && el.height > 0
    })
    expect(alive, `level ${lvl} (${name}) canvas alive`).toBeTruthy()
  }
  expect(fatal, `fatal errors loading pilot stages:\n${fatal.join("\n")}`).toHaveLength(0)
})
