"use client"

import { useCallback, useEffect, useState } from "react"
import WoodenBlocks, { LEVELS } from "@/components/wooden-blocks"
import { getProgress, resetProgress, type Progress } from "@/lib/progression"

type Screen = "title" | "levels" | "game"
const GRID = 25 // 5 × 5 board (levels beyond the ones built read as "locked")
const SOLVED_COLORS = ["#2b56be", "#eb7f37", "#78b2d6", "#d14332"]

export default function TitleShell() {
  const [screen, setScreen] = useState<Screen>("title")
  const [launch, setLaunch] = useState<number | null>(null)
  const [progress, setProgress] = useState<Progress>({ current: 0, solved: [] })

  // refresh progress whenever we land on the title or level board (so newly
  // passed levels show up after playing)
  const refresh = useCallback(() => setProgress(getProgress()), [])
  useEffect(() => {
    if (screen !== "game") refresh()
  }, [screen, refresh])

  if (screen === "game") {
    return (
      <WoodenBlocks
        key={launch ?? "resume"}
        initialLevel={launch ?? undefined}
        onExit={() => setScreen("levels")}
      />
    )
  }

  const startAt = (i: number) => {
    setLaunch(i)
    setScreen("game")
  }

  return (
    <main className="relative flex h-dvh w-full flex-col items-center justify-center overflow-hidden bg-[#f6f2ea] px-6 text-[#262626]">
      {screen === "title" ? (
        <div className="flex flex-col items-center gap-8">
          {/* the mark */}
          <img src="/icon.svg" alt="" width={108} height={108} className="rounded-[22%] shadow-sm" />
          {/* wordmark: each letter in a block colour */}
          <h1 className="font-klossete text-7xl leading-none tracking-tight sm:text-8xl">
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
          <div className="mt-1 flex flex-col items-center gap-3">
            <button
              type="button"
              onClick={() => startAt(progress.current)}
              className="font-klossete rounded-2xl bg-[#2b56be] px-10 py-3 text-2xl text-[#f6f2ea] transition active:scale-95"
            >
              play
            </button>
            <button
              type="button"
              onClick={() => setScreen("levels")}
              className="font-klossete rounded-2xl px-8 py-2 text-xl text-[#6b6155] underline-offset-4 transition hover:underline active:scale-95"
            >
              levels
            </button>
          </div>
        </div>
      ) : (
        <div className="flex w-full max-w-md flex-col items-center gap-6">
          <div className="flex w-full items-center justify-between">
            <button
              type="button"
              aria-label="Back"
              onClick={() => setScreen("title")}
              className="font-klossete text-xl text-[#6b6155] transition hover:text-[#262626] active:scale-95"
            >
              ‹ back
            </button>
            <h2 className="font-klossete text-2xl text-[#2b56be]">levels</h2>
            <span className="w-12 text-right text-xs text-[#9a9082]">
              {progress.solved.length}/{LEVELS.length}
            </span>
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
                  onClick={() => unlocked && startAt(i)}
                  aria-label={
                    exists ? `Level ${i + 1}: ${level.name}${solved ? " (passed)" : ""}` : `Level ${i + 1} (locked)`
                  }
                  title={exists ? level.name : "locked"}
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

          <button
            type="button"
            onClick={() => {
              if (typeof window !== "undefined" && window.confirm("Reset all progress?")) {
                resetProgress()
                refresh()
              }
            }}
            className="mt-1 text-xs text-[#b3aa9a] underline-offset-4 transition hover:underline"
          >
            reset progress
          </button>
        </div>
      )}
    </main>
  )
}
