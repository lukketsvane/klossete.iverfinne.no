"use client"

import { useCallback, useEffect, useRef, useState } from "react"

// The soundtrack — a looping playlist led by the Flåklypa-flavoured theme. It
// stays silent until the race actually starts (browsers block autoplay before a
// gesture), then fades in and advances track to track.
const PLAYLIST = [
  "/music/il-tempo-gigante.mp3",
  "/music/full-gass-i-taka.mp3",
  "/music/rod-rullende-dynamitt.mp3",
  "/music/pixel-fire.mp3",
]
const VOLUME = 0.55

export function useMusic() {
  const el = useRef<HTMLAudioElement | null>(null)
  const idx = useRef(0)
  const [on, setOn] = useState(true)
  const onRef = useRef(true)
  onRef.current = on

  // build the audio element once
  useEffect(() => {
    const a = new Audio(PLAYLIST[0])
    a.preload = "auto"
    a.volume = VOLUME
    a.addEventListener("ended", () => {
      idx.current = (idx.current + 1) % PLAYLIST.length
      a.src = PLAYLIST[idx.current]
      if (onRef.current) void a.play().catch(() => {})
    })
    el.current = a
    return () => {
      a.pause()
      el.current = null
    }
  }, [])

  // start playing from the top of the playlist (call on a user gesture)
  const start = useCallback(() => {
    const a = el.current
    if (!a || !onRef.current) return
    if (a.paused) void a.play().catch(() => {})
  }, [])

  const toggle = useCallback(() => {
    setOn((prev) => {
      const next = !prev
      const a = el.current
      if (a) {
        if (next) void a.play().catch(() => {})
        else a.pause()
      }
      return next
    })
  }, [])

  return { musicOn: on, startMusic: start, toggleMusic: toggle }
}
