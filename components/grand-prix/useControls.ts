"use client"

import { useEffect, useRef } from "react"

// A single 2D steering vector in camera space: y = forward (away from camera),
// x = right. Magnitude is clamped to the unit disc. The hook merges three input
// sources into one ref so the game loop can read it every frame without React
// re-renders: keyboard (WASD / arrows), an on-screen drag joystick (works on
// touch and mouse), and — when enabled — the device's tilt sensor.
export type Steer = { x: number; y: number }

export function useControls(tiltEnabled: boolean) {
  const steer = useRef<Steer>({ x: 0, y: 0 })
  const keys = useRef({ up: false, down: false, left: false, right: false })
  const drag = useRef<{ x: number; y: number } | null>(null)
  const tilt = useRef<{ x: number; y: number } | null>(null)

  // keyboard
  useEffect(() => {
    const set = (e: KeyboardEvent, down: boolean) => {
      switch (e.key) {
        case "ArrowUp":
        case "w":
        case "W":
          keys.current.up = down
          break
        case "ArrowDown":
        case "s":
        case "S":
          keys.current.down = down
          break
        case "ArrowLeft":
        case "a":
        case "A":
          keys.current.left = down
          break
        case "ArrowRight":
        case "d":
        case "D":
          keys.current.right = down
          break
        default:
          return
      }
      e.preventDefault()
    }
    const dn = (e: KeyboardEvent) => set(e, true)
    const up = (e: KeyboardEvent) => set(e, false)
    window.addEventListener("keydown", dn)
    window.addEventListener("keyup", up)
    return () => {
      window.removeEventListener("keydown", dn)
      window.removeEventListener("keyup", up)
    }
  }, [])

  // device tilt → steering (only while enabled)
  useEffect(() => {
    if (!tiltEnabled) {
      tilt.current = null
      return
    }
    const onOrient = (e: DeviceOrientationEvent) => {
      // beta: front/back tilt (deg), gamma: left/right tilt (deg). Hold the phone
      // roughly upright-tilted; map a ±35° window to the unit disc.
      const beta = e.beta ?? 0
      const gamma = e.gamma ?? 0
      const fwd = clamp((beta - 35) / 35, -1, 1) // tilt away from you = forward
      const side = clamp(gamma / 35, -1, 1)
      tilt.current = { x: side, y: fwd }
    }
    window.addEventListener("deviceorientation", onOrient)
    return () => window.removeEventListener("deviceorientation", onOrient)
  }, [tiltEnabled])

  // merge sources every animation frame
  useEffect(() => {
    let raf = 0
    const tick = () => {
      let x = 0
      let y = 0
      const k = keys.current
      if (k.left) x -= 1
      if (k.right) x += 1
      if (k.up) y += 1
      if (k.down) y -= 1
      if (drag.current) {
        x += drag.current.x
        y += drag.current.y
      }
      if (tilt.current) {
        x += tilt.current.x
        y += tilt.current.y
      }
      // clamp to unit disc
      const m = Math.hypot(x, y)
      if (m > 1) {
        x /= m
        y /= m
      }
      steer.current.x = x
      steer.current.y = y
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return { steer, drag }
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}
