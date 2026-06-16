// Wooden-block impact sounds played from real recorded samples in /public.
//
// We load a small pool of wood-knock mp3s, then on each collision play one
// through a velocity-driven low-pass + gain: soft taps come out dull and quiet,
// hard knocks crack and ring. Each block gets a size-derived base pitch (bigger
// pieces knock lower) plus a little per-hit random detune so repeats never sound
// machine-gunned.

let ctx: AudioContext | null = null
let master: GainNode | null = null
let muted = false
let lastPlay = 0

// recorded wood-knock variations (decoded from the mp3s in /public)
const SAMPLE_URLS = ["/toy_building_block_wood_01.mp3", "/toy_building_block_wood_02.mp3"]
let samples: AudioBuffer[] = []
let loadStarted = false

// id -> base playback rate, derived from the block's size (pitch)
const baseRate = new Map<string, number>()

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

function ensureCtx(): AudioContext | null {
  if (typeof window === "undefined") return null
  if (!ctx) {
    const AC: typeof AudioContext | undefined =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return null
    ctx = new AC()
    master = ctx.createGain()
    master.gain.value = 0.7
    master.connect(ctx.destination)
  }
  return ctx
}

// Fetch + decode the sample pool once. Safe to call repeatedly.
function loadSamples() {
  const c = ensureCtx()
  if (!c || loadStarted) return
  loadStarted = true
  SAMPLE_URLS.forEach(async (url, i) => {
    try {
      const res = await fetch(url)
      const arr = await res.arrayBuffer()
      samples[i] = await c.decodeAudioData(arr)
    } catch {
      // a missing/unsupported sample just drops out of the pool
    }
  })
}

// Must be called from a real user gesture. iOS/Safari keeps the AudioContext
// "suspended" until a sound is actually started inside a gesture, so we resume
// AND start a one-sample silent buffer to fully unlock playback.
export function unlockAudio() {
  const c = ensureCtx()
  if (!c) return
  if (c.state === "suspended") void c.resume()
  try {
    const buf = c.createBuffer(1, 1, c.sampleRate)
    const src = c.createBufferSource()
    src.buffer = buf
    src.connect(c.destination)
    src.start(0)
  } catch {}
  loadSamples()
}

/** True once the audio context is actually running (so callers can stop retrying). */
export function audioReady(): boolean {
  return !!ctx && ctx.state === "running"
}

export function setMuted(value: boolean) {
  muted = value
  if (!value) unlockAudio()
}

/** Map each block's size-derived frequency to a base pitch and warm the samples. */
export function primeBlocks(specs: { id: string; freq: number }[]) {
  ensureCtx()
  loadSamples()
  for (const { id, freq } of specs) {
    // freq runs ~230 (big pieces) .. ~680 (small) -> rate 0.82 .. 1.25
    const n = clamp((freq - 230) / (680 - 230), 0, 1)
    baseRate.set(id, 0.82 + n * 0.43)
  }
}

/**
 * Play one impact for a block.
 * @param id       block id (must have been primed)
 * @param strength 0..1 – how hard the hit was
 */
export function playImpact(id: string, strength: number) {
  if (muted) return
  const c = ensureCtx()
  if (!c || !master || c.state !== "running") return

  const ready = samples.filter(Boolean)
  if (ready.length === 0) return

  const now = c.currentTime
  if (now - lastPlay < 0.015) return
  lastPlay = now

  const v = clamp(strength, 0, 1)
  if (v < 0.02) return

  const src = c.createBufferSource()
  src.buffer = ready[(Math.random() * ready.length) | 0]
  // size-based base pitch with a little ±5% per-hit detune so hits vary
  src.playbackRate.value = (baseRate.get(id) ?? 1) * (1 + (Math.random() * 0.1 - 0.05))

  // Harder hits excite more high-frequency energy: open the low-pass with v.
  const lp = c.createBiquadFilter()
  lp.type = "lowpass"
  lp.frequency.value = 700 + v * v * 9000
  lp.Q.value = 0.6

  const g = c.createGain()
  g.gain.value = Math.min(1, 0.12 + v * 0.95)

  src.connect(lp).connect(g).connect(master)
  src.start()
}

/**
 * Play a soft mallet/bell tone – used by the "music tile" floor.
 * @param freq     fundamental frequency (Hz)
 * @param strength 0..1 – how hard the tile was struck
 */
export function playTone(freq: number, strength: number) {
  if (muted) return
  const c = ensureCtx()
  if (!c || !master || c.state !== "running") return

  const now = c.currentTime
  const v = clamp(strength, 0, 1)
  if (v < 0.02) return

  // bell-ish mallet: a fundamental plus a quiet inharmonic partial, struck with
  // a fast attack and a soft exponential decay
  const env = c.createGain()
  env.gain.setValueAtTime(0.0001, now)
  env.gain.exponentialRampToValueAtTime(Math.min(0.5, 0.1 + v * 0.45), now + 0.006)
  env.gain.exponentialRampToValueAtTime(0.0001, now + 1.1)

  const o1 = c.createOscillator()
  o1.type = "sine"
  o1.frequency.value = freq

  const o2 = c.createOscillator()
  o2.type = "sine"
  o2.frequency.value = freq * 2.76 // inharmonic shimmer
  const o2g = c.createGain()
  o2g.gain.value = 0.18

  o1.connect(env)
  o2.connect(o2g).connect(env)
  env.connect(master)
  o1.start(now)
  o2.start(now)
  o1.stop(now + 1.15)
  o2.stop(now + 1.15)
}
