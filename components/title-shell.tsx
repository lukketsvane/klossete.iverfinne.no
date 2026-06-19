"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Check, ChevronLeft, ChevronRight, X } from "lucide-react"
import WoodenBlocks, { LEVELS } from "@/components/wooden-blocks"
import { getProgress, type Progress } from "@/lib/progression"
import { getSettings, setSound, setMusic, setSoundVol, setMusicVol, setTiltPref } from "@/lib/settings"
import { setMuted, setVolume } from "@/lib/impact-sound"

type Screen = "title" | "game"
type Overlay = null | "levels" | "help"
const GRID = LEVELS.length // one cell per built level
const SOLVED_COLORS = ["#2b56be", "#eb7f37", "#78b2d6", "#d14332"]
// the soundtrack, played as a loop. ost-main is the xylophone main/intro theme
// (it leads); the others come round later in the rotation.
const OST_TRACKS = [
  "/music/ost-main.mp3",
  "/music/ost-1.mp3",
  "/music/ost-2.mp3",
  "/music/ost-3.mp3",
  "/music/ost-4.mp3", // the full "eg tilstår" vocal track
]
const SOUNDBOX_ID = "soundbox" // the level where the player makes the music themselves

export default function TitleShell() {
  const [screen, setScreen] = useState<Screen>("title")
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [launch, setLaunch] = useState<number | null>(null)
  const [liveLevel, setLiveLevel] = useState<number | null>(null) // the level currently open in-game
  const [progress, setProgress] = useState<Progress>({ current: 0, solved: [] })
  const [sound, setSoundOn] = useState(true)
  const [music, setMusicOn] = useState(true)
  const [soundVol, setSoundVolState] = useState(0.8)
  const [musicVol, setMusicVolState] = useState(0.5)
  const musicVolRef = useRef(0.5)
  musicVolRef.current = musicVol
  const [tilt, setTiltOn] = useState(false)
  const musicEl = useRef<HTMLAudioElement | null>(null)
  const trackIdx = useRef(0)
  const fadeRaf = useRef<number | null>(null)

  // load saved settings once on mount + keep the audio engine in sync
  useEffect(() => {
    const s = getSettings()
    setSoundOn(s.sound)
    setMusicOn(s.music)
    setSoundVolState(s.soundVol)
    setMusicVolState(s.musicVol)
    setTiltOn(s.tilt)
    setMuted(!s.sound)
    setVolume(s.soundVol)
  }, [])

  // The OST (a multi-track playlist) waits until you actually start the game, then
  // fades in to the music-volume slider level and loops (when one track ends we
  // advance to the next and wrap around). Turning music off pauses it at once.
  const fadeInMusic = useCallback(() => {
    const a = musicEl.current
    if (!a) return
    if (fadeRaf.current) cancelAnimationFrame(fadeRaf.current)
    a.volume = 0
    void a.play().catch(() => {})
    const t0 = performance.now()
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / 1600)
      a.volume = musicVolRef.current * k
      if (k < 1) fadeRaf.current = requestAnimationFrame(step)
      else fadeRaf.current = null
    }
    fadeRaf.current = requestAnimationFrame(step)
  }, [])

  // the soundbox level falls silent so the player can hear the tiles they strike
  // (and the music button is locked there – the hush is itself the hint)
  const onSoundbox = screen === "game" && LEVELS[liveLevel ?? -1]?.id === SOUNDBOX_ID
  // start (fade) once the game begins / music turns back on; pause when music is
  // off or while on the soundbox level. Never plays in the menu before a game.
  useEffect(() => {
    const a = musicEl.current
    if (!a) return
    if (!music || onSoundbox) a.pause()
    else if (screen === "game" && a.paused) fadeInMusic()
  }, [screen, music, onSoundbox, fadeInMusic])

  const onTrackEnded = () => {
    const a = musicEl.current
    if (!a) return
    trackIdx.current = (trackIdx.current + 1) % OST_TRACKS.length
    a.src = OST_TRACKS[trackIdx.current]
    a.volume = musicVolRef.current
    void a.play().catch(() => {})
  }

  const toggleMusic = () => {
    const next = !music
    setMusicOn(next)
    setMusic(next)
  }

  // refresh progress whenever we land back on the menu (so newly passed levels show up)
  const refresh = useCallback(() => setProgress(getProgress()), [])
  useEffect(() => {
    if (screen !== "game") refresh()
  }, [screen, refresh])

  const startAt = (i: number) => {
    setLaunch(i)
    setScreen("game")
  }

  // menu volume sliders (0..1). Sound feeds the effects master gain; music sets
  // the OST element volume live. Dragging to 0 also flips the matching in-game
  // mute flag so the cluster button reads in sync.
  const onSoundVolChange = (v: number) => {
    setSoundVolState(v)
    setSoundVol(v)
    setVolume(v)
    const on = v > 0
    if (on !== sound) {
      setSoundOn(on)
      setSound(on)
      setMuted(!on)
    }
  }
  const onMusicVolChange = (v: number) => {
    setMusicVolState(v)
    setMusicVol(v)
    if (musicEl.current) musicEl.current.volume = v
    const on = v > 0
    if (on !== music) {
      setMusicOn(on)
      setMusic(on)
    }
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
      {/* the OST – a two-track playlist looping under the whole experience, gated
          by the music toggle */}
      <audio ref={musicEl} src={OST_TRACKS[0]} preload="auto" onEnded={onTrackEnded} />
      {screen === "game" ? (
        <WoodenBlocks
          key={launch ?? "resume"}
          initialLevel={launch ?? undefined}
          initialMuted={!sound}
          initialTilt={tilt}
          musicOn={music}
          onToggleMusic={toggleMusic}
          musicLocked={onSoundbox}
          onLevel={setLiveLevel}
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
            <SettingSlider label="lyd" value={soundVol} onChange={onSoundVolChange} />
            <SettingSlider label="musikk" value={musicVol} onChange={onMusicVolChange} />
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
          current={screen === "game" ? liveLevel ?? launch ?? progress.current : progress.current}
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

function ControlRow({ icon, label }: { icon: string; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <img src={icon} alt="" width={40} height={40} className="h-10 w-10 shrink-0 object-contain" />
      <span>{label}</span>
    </div>
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

function SettingSlider({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (v: number) => void
}) {
  return (
    <label className="font-klossete flex items-center gap-4 rounded-2xl bg-[#efe9dd] px-5 py-3 text-lg text-[#473f33]">
      <span className="w-28 shrink-0">{label}</span>
      <input
        type="range"
        min={0}
        max={100}
        value={Math.round(value * 100)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        aria-label={label}
        className="h-2 w-full cursor-pointer appearance-none rounded-full bg-[#d8d0bf] accent-[#2b56be]"
      />
    </label>
  )
}

const PAGE_SIZE = 25 // levels per page in the picker

// A rough, hand-drawn crayon outline around the level you're currently on. The
// turbulence + displacement filter roughens the rounded rect so it reads as a
// wobbly crayon stroke rather than a clean ring.
function CrayonOutline() {
  return (
    <svg
      className="pointer-events-none absolute -inset-1"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden
    >
      <defs>
        <filter id="crayon-rough" x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency="0.09" numOctaves="2" seed="7" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="4" />
        </filter>
      </defs>
      <rect
        x="9"
        y="9"
        width="82"
        height="82"
        rx="16"
        fill="none"
        stroke="#2b56be"
        strokeWidth="4"
        strokeLinecap="round"
        filter="url(#crayon-rough)"
      />
    </svg>
  )
}

function LevelOverlay({
  progress,
  current,
  onClose,
  onHome,
  onPick,
}: {
  progress: Progress
  current: number // the level the player is on right now (for the page + highlight)
  onClose: () => void
  onHome: () => void
  onPick: (i: number) => void
}) {
  const pages = Math.max(1, Math.ceil(GRID / PAGE_SIZE))
  const [page, setPage] = useState(() => Math.min(pages - 1, Math.max(0, Math.floor(current / PAGE_SIZE))))
  const startIdx = page * PAGE_SIZE
  const count = Math.min(PAGE_SIZE, GRID - startIdx)

  return (
    <div
      className="fixed inset-0 z-20 flex items-center justify-center bg-[#26262699] px-5 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative flex w-full max-w-md flex-col items-center gap-5 rounded-3xl bg-[#f6f2ea] p-6 shadow-xl"
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
          {Array.from({ length: count }, (_, j) => {
            const i = startIdx + j
            const level = LEVELS[i]
            const solved = progress.solved.includes(level.id)
            const isCurrent = i === current
            const fill = solved ? SOLVED_COLORS[i % SOLVED_COLORS.length] : undefined
            return (
              <button
                key={i}
                type="button"
                onClick={() => onPick(i)}
                aria-label={`Nivå ${i + 1}: ${level.name}${solved ? " (klart)" : ""}${isCurrent ? " (her er du)" : ""}`}
                title={level.name}
                className="font-klossete relative flex aspect-square items-center justify-center rounded-xl text-xl transition active:scale-95 hover:brightness-105"
                style={{
                  background: fill ?? "#e7e1d5",
                  color: solved ? "#f6f2ea" : "#473f33",
                }}
              >
                {i + 1}
                {isCurrent && <CrayonOutline />}
              </button>
            )
          })}
        </div>

        {pages > 1 && (
          <div className="flex w-full items-center justify-center gap-6">
            <button
              type="button"
              aria-label="Førre side"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="flex h-9 w-9 items-center justify-center rounded-full text-[#6b6155] transition hover:bg-[#e7e1d5] hover:text-[#262626] active:scale-95 disabled:opacity-30"
            >
              <ChevronLeft className="h-5 w-5" strokeWidth={2.4} />
            </button>
            <span className="font-klossete text-base text-[#6b6155]">
              {page + 1}/{pages}
            </span>
            <button
              type="button"
              aria-label="Neste side"
              disabled={page >= pages - 1}
              onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
              className="flex h-9 w-9 items-center justify-center rounded-full text-[#6b6155] transition hover:bg-[#e7e1d5] hover:text-[#262626] active:scale-95 disabled:opacity-30"
            >
              <ChevronRight className="h-5 w-5" strokeWidth={2.4} />
            </button>
          </div>
        )}
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

        <div className="flex flex-col gap-3 text-[15px] leading-snug text-[#473f33]">
          <ControlRow icon="/pictograms/one-finger.png" label="Dra med éin finger for å flytte klossen." />
          <ControlRow icon="/pictograms/swipe-vertical.png" label="Sveip med to fingrar for å snu klossen til neste side." />
          <ControlRow icon="/pictograms/rotate-crayon.png" label="Roter med to fingrar for å vri klossen." />
        </div>

        <div className="rounded-2xl bg-[#efe9dd] p-4 text-sm leading-snug text-[#6b6155]">
          Vipp telefonen for å la tyngdekrafta dra klossane (skru på rørslesensor). Spelet er berre laga for mobil, og er finast lagt til på heimskjermen.
        </div>
      </div>
    </div>
  )
}
