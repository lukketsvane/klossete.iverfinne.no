"use client"

import { useCallback, useEffect, useState } from "react"
import { Check, X } from "lucide-react"
import WoodenBlocks, { LEVELS } from "@/components/wooden-blocks"
import { getProgress, type Progress } from "@/lib/progression"
import { getSettings, setSound, setTiltPref } from "@/lib/settings"
import { setMuted } from "@/lib/impact-sound"

type Screen = "title" | "game"
type Overlay = null | "levels" | "help"
const GRID = 25 // 5 × 5 board (levels beyond the ones built read as "locked")
const SOLVED_COLORS = ["#2b56be", "#eb7f37", "#78b2d6", "#d14332"]

export default function TitleShell() {
  const [screen, setScreen] = useState<Screen>("title")
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [launch, setLaunch] = useState<number | null>(null)
  const [progress, setProgress] = useState<Progress>({ current: 0, solved: [] })
  const [sound, setSoundOn] = useState(true)
  const [tilt, setTiltOn] = useState(false)

  // load saved settings once on mount + keep the audio engine in sync
  useEffect(() => {
    const s = getSettings()
    setSoundOn(s.sound)
    setTiltOn(s.tilt)
    setMuted(!s.sound)
  }, [])

  // refresh progress whenever we land back on the menu (so newly passed levels show up)
  const refresh = useCallback(() => setProgress(getProgress()), [])
  useEffect(() => {
    if (screen !== "game") refresh()
  }, [screen, refresh])

  const startAt = (i: number) => {
    setLaunch(i)
    setScreen("game")
  }

  const toggleSound = () => {
    const next = !sound
    setSoundOn(next)
    setSound(next)
    setMuted(!next)
  }

  // The accelerometer needs an explicit permission grant on iOS 13+, and it must
  // come from a user gesture (this tap). Elsewhere it's available right away.
  const toggleTilt = async () => {
    if (tilt) {
      setTiltOn(false)
      setTiltPref(false)
      return
    }
    const DOE = (typeof window !== "undefined" ? (window as any).DeviceOrientationEvent : null) as any
    try {
      if (DOE && typeof DOE.requestPermission === "function") {
        const res = await DOE.requestPermission()
        if (res !== "granted") return
      }
    } catch {
      return
    }
    setTiltOn(true)
    setTiltPref(true)
  }

  return (
    <>
      {screen === "game" ? (
        <WoodenBlocks
          key={launch ?? "resume"}
          initialLevel={launch ?? undefined}
          initialMuted={!sound}
          initialTilt={tilt}
          // the grid button opens the level picker OVER the running level, so it
          // never throws you back out to the main menu
          onExit={() => {
            refresh()
            setOverlay("levels")
          }}
        />
      ) : (
        <main className="relative flex h-dvh w-full flex-col items-center justify-between overflow-hidden bg-[#f6f2ea] px-6 pb-10 pt-16 text-[#262626]">
          {/* wordmark */}
          <h1 className="font-klossete mt-8 text-6xl leading-none tracking-tight sm:text-7xl">
            {"kl.oss.ete".split("").map((ch, i) =>
              ch === "." ? (
                <span key={i} style={{ color: "#7c7264" }}>
                  {ch}
                </span>
              ) : (
                <span key={i} style={{ color: SOLVED_COLORS[i % SOLVED_COLORS.length] }}>
                  {ch}
                </span>
              ),
            )}
          </h1>

          {/* settings + level access */}
          <div className="flex w-full max-w-xs flex-col items-stretch gap-3">
            <SettingRow label="lyd" checked={sound} onClick={toggleSound} />
            <SettingRow label="rørslesensor" checked={tilt} onClick={toggleTilt} />

            <button
              type="button"
              onClick={() => setOverlay("levels")}
              className="font-klossete mt-1 rounded-2xl bg-[#e7e1d5] px-8 py-3 text-xl text-[#473f33] transition active:scale-95 hover:brightness-105"
            >
              nivå
            </button>
            <button
              type="button"
              onClick={() => setOverlay("help")}
              className="font-klossete text-base text-[#9a9082] underline-offset-4 transition hover:text-[#6b6155] hover:underline active:scale-95"
            >
              korleis spele
            </button>
          </div>

          {/* the primary action lives at the very bottom */}
          <button
            type="button"
            onClick={() => startAt(progress.current)}
            className="font-klossete w-full max-w-xs rounded-2xl bg-[#2b56be] px-10 py-4 text-2xl text-[#f6f2ea] transition active:scale-95 hover:brightness-105"
          >
            start spelet
          </button>
        </main>
      )}

      {overlay === "levels" && (
        <LevelOverlay
          progress={progress}
          onClose={() => setOverlay(null)}
          onHome={() => {
            setOverlay(null)
            setScreen("title")
          }}
          onPick={(i) => {
            if (screen === "game") {
              setLaunch(i) // switch the running level in place, stay in the game
              setOverlay(null)
            } else {
              startAt(i)
            }
          }}
        />
      )}
      {overlay === "help" && <HelpOverlay onClose={() => setOverlay(null)} />}
    </>
  )
}

function SettingRow({
  label,
  checked,
  onClick,
}: {
  label: string
  checked: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onClick}
      className="font-klossete flex items-center justify-between rounded-2xl bg-[#efe9dd] px-5 py-3 text-lg text-[#473f33] transition active:scale-[0.98] hover:brightness-105"
    >
      <span>{label}</span>
      <span
        className="flex h-6 w-6 items-center justify-center rounded-md transition"
        style={{
          background: checked ? "#2b56be" : "transparent",
          border: checked ? "none" : "2px solid #c3bba9",
        }}
      >
        {checked && <Check className="h-4 w-4 text-[#f6f2ea]" strokeWidth={3} />}
      </span>
    </button>
  )
}

function LevelOverlay({
  progress,
  onClose,
  onHome,
  onPick,
}: {
  progress: Progress
  onClose: () => void
  onHome: () => void
  onPick: (i: number) => void
}) {
  return (
    <div
      className="fixed inset-0 z-20 flex items-center justify-center bg-[#26262699] px-5 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative flex w-full max-w-md flex-col items-center gap-6 rounded-3xl bg-[#f6f2ea] p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex w-full items-center justify-between">
          <button
            type="button"
            aria-label="Hovudmeny"
            onClick={onHome}
            className="font-klossete text-lg text-[#6b6155] transition hover:text-[#262626] active:scale-95"
          >
            ‹ hovudmeny
          </button>
          <h2 className="font-klossete text-2xl text-[#2b56be]">nivå</h2>
          <button
            type="button"
            aria-label="Lukk"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-full text-[#6b6155] transition hover:bg-[#e7e1d5] hover:text-[#262626] active:scale-95"
          >
            <X className="h-5 w-5" strokeWidth={2.4} />
          </button>
        </div>

        <div className="grid w-full grid-cols-5 gap-2.5">
          {Array.from({ length: GRID }, (_, i) => {
            const level = LEVELS[i]
            const exists = i < LEVELS.length
            const solved = exists && progress.solved.includes(level.id)
            const unlocked = exists // every built level is open from the board
            const isCurrent = exists && i === progress.current && !solved
            const fill = solved ? SOLVED_COLORS[i % SOLVED_COLORS.length] : undefined
            return (
              <button
                key={i}
                type="button"
                disabled={!unlocked}
                onClick={() => unlocked && onPick(i)}
                aria-label={
                  exists ? `Nivå ${i + 1}: ${level.name}${solved ? " (klart)" : ""}` : `Nivå ${i + 1} (låst)`
                }
                title={exists ? level.name : "låst"}
                className={`font-klossete relative flex aspect-square items-center justify-center rounded-xl text-xl transition ${
                  unlocked ? "active:scale-95 hover:brightness-105" : "cursor-not-allowed"
                } ${isCurrent ? "ring-2 ring-[#2b56be] ring-offset-2 ring-offset-[#f6f2ea]" : ""}`}
                style={{
                  background: fill ?? (unlocked ? "#e7e1d5" : "#eee9df"),
                  color: solved ? "#f6f2ea" : unlocked ? "#473f33" : "#bdb4a4",
                  opacity: unlocked ? 1 : 0.55,
                }}
              >
                {i + 1}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function HelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-20 flex items-center justify-center bg-[#26262699] px-5 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative flex w-full max-w-md flex-col gap-5 rounded-3xl bg-[#f6f2ea] p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-klossete text-2xl text-[#2b56be]">korleis spele</h2>
          <button
            type="button"
            aria-label="Lukk"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-full text-[#6b6155] transition hover:bg-[#e7e1d5] hover:text-[#262626] active:scale-95"
          >
            <X className="h-5 w-5" strokeWidth={2.4} />
          </button>
        </div>

        <div className="flex flex-col gap-2.5 text-[15px] leading-snug text-[#473f33]">
          <p>
            <span className="font-semibold">Tap og hald:</span> hald på klossen for å løfte han.
          </p>
          <p>
            <span className="font-semibold">Dra:</span> flytt klossane med fingeren.
          </p>
          <p>
            <span className="font-semibold">Pinch:</span> knip med to fingrar for presisjon når du roterer klossen.
          </p>
          <p>
            <span className="font-semibold">Vipp:</span> vipp telefonen, så dreg tyngdekrafta klossane.
          </p>
          <p>Få klossane på plass, så løyser nivået seg.</p>
        </div>

        <div className="rounded-2xl bg-[#efe9dd] p-4 text-sm leading-snug text-[#6b6155]">
          Spelet er berre laga for mobil. Skru på rørslesensor for best oppleving, og legg klossete til på heimskjermen.
        </div>
      </div>
    </div>
  )
}
