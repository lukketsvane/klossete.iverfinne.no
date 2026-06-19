"use client"

import { useEffect, useRef, useState } from "react"
import type { Steer } from "./useControls"
import { TRACK } from "@/lib/track"

const TOTAL_CP = TRACK.checkpoints.filter((c) => !c.finish && c.index > 0).length

function fmt(ms: number) {
  const s = ms / 1000
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`
}

// A clock that ticks while racing and freezes on finish.
function Clock({ phase, startAt, finishAt }: { phase: Phase; startAt: number; finishAt: number }) {
  const [, force] = useState(0)
  useEffect(() => {
    if (phase !== "racing") return
    let raf = 0
    const tick = () => {
      force((n) => n + 1)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [phase])
  const ms = phase === "won" ? finishAt - startAt : phase === "racing" ? Date.now() - startAt : 0
  return <span className="tabular-nums">{fmt(Math.max(0, ms))}</span>
}

export type Phase = "ready" | "racing" | "won"

export function Hud({
  phase,
  cpHit,
  startAt,
  finishAt,
  tiltEnabled,
  musicOn,
  speedRef,
  drag,
  onStart,
  onRestart,
  onToggleTilt,
  onToggleMusic,
}: {
  phase: Phase
  cpHit: number
  startAt: number
  finishAt: number
  tiltEnabled: boolean
  musicOn: boolean
  speedRef: React.MutableRefObject<number>
  drag: React.MutableRefObject<{ x: number; y: number } | null>
  onStart: () => void
  onRestart: () => void
  onToggleTilt: () => void
  onToggleMusic: () => void
}) {
  return (
    <div className="pointer-events-none absolute inset-0 select-none">
      {/* top status bar (during the race) */}
      {phase !== "ready" && (
        <div className="absolute left-0 right-0 top-0 flex items-start justify-between p-4 text-[#2c2620]">
          <div className="font-klossete rounded-2xl bg-[#f6f2eacc] px-4 py-2 text-2xl backdrop-blur-sm">
            <Clock phase={phase} startAt={startAt} finishAt={finishAt} />
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="font-klossete rounded-2xl bg-[#f6f2eacc] px-4 py-2 text-lg backdrop-blur-sm">
              sjekkpunkt {cpHit}/{TOTAL_CP}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onToggleMusic}
                aria-label="Musikk av/på"
                className="font-klossete pointer-events-auto rounded-2xl bg-[#f6f2eacc] px-3 py-2 text-base text-[#2c2620] backdrop-blur-sm transition active:scale-95"
              >
                {musicOn ? "♪" : "♪̶"}
              </button>
              <button
                type="button"
                onClick={onRestart}
                className="font-klossete pointer-events-auto rounded-2xl bg-[#2b56be] px-4 py-2 text-base text-[#f6f2ea] transition active:scale-95"
              >
                start på nytt
              </button>
            </div>
          </div>
        </div>
      )}

      {/* on-screen joystick (always available for touch / mouse) */}
      {phase === "racing" && <Joystick drag={drag} />}
      {phase === "racing" && <Speedo speedRef={speedRef} />}

      {/* ready / title screen */}
      {phase === "ready" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-[#f6f2ea66] px-6 backdrop-blur-[2px]">
          <h1 className="font-klossete text-center text-5xl leading-none text-[#2c2620] sm:text-7xl">
            <span style={{ color: "#d14332" }}>klossete</span>
            <br />
            <span style={{ color: "#2b56be" }}>grand prix</span>
          </h1>
          <p className="max-w-xs text-center text-sm text-[#6b6155]">
            Rull den raude sylinderen gjennom tåka. Styr med piltastane, dra på
            skjermen, eller vipp telefonen.
          </p>
          <div className="flex flex-col items-center gap-3">
            <button
              type="button"
              onClick={onStart}
              className="font-klossete pointer-events-auto rounded-2xl bg-[#2b56be] px-10 py-4 text-2xl text-[#f6f2ea] transition active:scale-95 hover:brightness-105"
            >
              start løpet
            </button>
            <button
              type="button"
              onClick={onToggleTilt}
              className="font-klossete pointer-events-auto text-base text-[#6b6155] underline-offset-4 hover:underline"
            >
              rørslesensor: {tiltEnabled ? "på" : "av"}
            </button>
          </div>
        </div>
      )}

      {/* finished */}
      {phase === "won" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-[#f6f2ea99] px-6 backdrop-blur-sm">
          <h2 className="font-klossete text-4xl text-[#2b56be]">i mål!</h2>
          <div className="font-klossete text-5xl tabular-nums text-[#2c2620]">
            {fmt(Math.max(0, finishAt - startAt))}
          </div>
          <button
            type="button"
            onClick={onRestart}
            className="font-klossete pointer-events-auto rounded-2xl bg-[#2b56be] px-10 py-4 text-2xl text-[#f6f2ea] transition active:scale-95 hover:brightness-105"
          >
            køyr igjen
          </button>
        </div>
      )}
    </div>
  )
}

// A simple speed read-out, polled from the ref so it never re-renders the tree.
function Speedo({ speedRef }: { speedRef: React.MutableRefObject<number> }) {
  const [v, setV] = useState(0)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      setV(speedRef.current)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [speedRef])
  return (
    <div className="font-klossete absolute bottom-6 right-6 rounded-2xl bg-[#f6f2eacc] px-4 py-2 text-xl tabular-nums text-[#2c2620] backdrop-blur-sm">
      {(v * 3.6).toFixed(0)} km/t
    </div>
  )
}

// Bottom-left virtual stick: drag to steer. Writes a unit-disc vector into the
// shared `drag` ref (y is forward, away from the camera).
function Joystick({ drag }: { drag: React.MutableRefObject<{ x: number; y: number } | null> }) {
  const base = useRef<HTMLDivElement>(null)
  const knob = useRef<HTMLDivElement>(null)
  const active = useRef(false)
  const R = 56

  const move = (cx: number, cy: number, clientX: number, clientY: number) => {
    let dx = (clientX - cx) / R
    let dy = (clientY - cy) / R
    const m = Math.hypot(dx, dy)
    if (m > 1) {
      dx /= m
      dy /= m
    }
    drag.current = { x: dx, y: -dy } // screen-down is -forward
    if (knob.current) knob.current.style.transform = `translate(${dx * R}px, ${dy * R}px)`
  }

  const onDown = (e: React.PointerEvent) => {
    const el = base.current
    if (!el) return
    active.current = true
    el.setPointerCapture(e.pointerId)
    const r = el.getBoundingClientRect()
    move(r.left + r.width / 2, r.top + r.height / 2, e.clientX, e.clientY)
  }
  const onMove = (e: React.PointerEvent) => {
    if (!active.current) return
    const el = base.current
    if (!el) return
    const r = el.getBoundingClientRect()
    move(r.left + r.width / 2, r.top + r.height / 2, e.clientX, e.clientY)
  }
  const onUp = () => {
    active.current = false
    drag.current = null
    if (knob.current) knob.current.style.transform = "translate(0px, 0px)"
  }

  return (
    <div
      ref={base}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      className="pointer-events-auto absolute bottom-6 left-6 flex h-32 w-32 touch-none items-center justify-center rounded-full bg-[#f6f2ea66] backdrop-blur-sm"
    >
      <div
        ref={knob}
        className="h-14 w-14 rounded-full bg-[#2b56becc] shadow-md transition-none"
      />
    </div>
  )
}
