// Wooden-block impact sounds, synthesised on the fly with the Web Audio API.
//
// Each collision plays a short percussive knock: a filtered noise transient for
// the "tick" of contact plus a quick low body "thunk", shaped by a velocity-
// driven bandpass + gain so soft taps come out dull and quiet while hard knocks
// crack and ring. Each block gets a size-derived base pitch (bigger pieces knock
// lower) plus a little per-hit random detune so repeats never sound machine-
// gunned. Fully self-contained – no external audio assets to ship or 404 on.

let ctx: AudioContext | null = null
let master: GainNode | null = null
let muted = false
let volume = 0.8 // effects volume (the menu slider); the master gain is muted ? 0 : volume
let lastPlay = 0

function applyGain() {
  if (master) master.gain.value = muted ? 0 : volume
}

// id -> base playback rate, derived from the block's size (pitch)
const baseRate = new Map<string, number>()

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

// A short burst of decaying white noise, reused as the contact "tick" source.
let noiseBuf: AudioBuffer | null = null
function noiseBuffer(c: AudioContext): AudioBuffer {
  if (noiseBuf && noiseBuf.sampleRate === c.sampleRate) return noiseBuf
  const len = Math.ceil(c.sampleRate * 0.14)
  const buf = c.createBuffer(1, len, c.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < len; i++) {
    const t = i / len
    data[i] = (Math.random() * 2 - 1) * (1 - t) * (1 - t) // fast-decaying
  }
  noiseBuf = buf
  return buf
}

function ensureCtx(): AudioContext | null {
  if (typeof window === "undefined") return null
  if (!ctx) {
    const AC: typeof AudioContext | undefined =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return null
    ctx = new AC()
    master = ctx.createGain()
    master.gain.value = muted ? 0 : volume
    master.connect(ctx.destination)
  }
  return ctx
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
}

/** True once the audio context is actually running (so callers can stop retrying). */
export function audioReady(): boolean {
  return !!ctx && ctx.state === "running"
}

export function setMuted(value: boolean) {
  muted = value
  applyGain()
  if (!value) unlockAudio()
}

/** Set the effects volume (0..1) from the menu slider. */
export function setVolume(v: number) {
  volume = Math.max(0, Math.min(1, v))
  applyGain()
  if (volume > 0) unlockAudio()
}

/** Map each block's size-derived frequency to a base pitch. */
export function primeBlocks(specs: { id: string; freq: number }[]) {
  ensureCtx()
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

  const now = c.currentTime
  if (now - lastPlay < 0.015) return
  lastPlay = now

  const v = clamp(strength, 0, 1)
  if (v < 0.02) return

  // size-based base pitch with a little ±5% per-hit detune so hits vary
  const rate = (baseRate.get(id) ?? 1) * (1 + (Math.random() * 0.1 - 0.05))

  // 1) contact "tick": a short noise burst through a bandpass that opens with
  //    velocity – soft taps stay dull, hard knocks get a bright crack.
  const noise = c.createBufferSource()
  noise.buffer = noiseBuffer(c)
  noise.playbackRate.value = rate
  const bp = c.createBiquadFilter()
  bp.type = "bandpass"
  bp.frequency.value = (650 + v * v * 5200) * rate
  bp.Q.value = 1.2 + v * 3
  const ng = c.createGain()
  ng.gain.setValueAtTime(Math.min(0.6, 0.07 + v * 0.55), now)
  ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.09 + v * 0.05)
  noise.connect(bp).connect(ng).connect(master)
  noise.start(now)
  noise.stop(now + 0.16)

  // 2) body "thunk": a low sine that drops a little in pitch as it decays, giving
  //    the knock a woody weight (bigger blocks -> lower, via rate).
  const base = 190 * rate
  const o = c.createOscillator()
  o.type = "sine"
  o.frequency.setValueAtTime(base, now)
  o.frequency.exponentialRampToValueAtTime(base * 0.7, now + 0.09)
  const og = c.createGain()
  og.gain.setValueAtTime(Math.min(0.5, 0.05 + v * 0.45), now)
  og.gain.exponentialRampToValueAtTime(0.0001, now + 0.11)
  o.connect(og).connect(master)
  o.start(now)
  o.stop(now + 0.13)
}

/** Short telegraph beep for the Morse-code celebration. */
export function playBeep() {
  if (muted) return
  const c = ensureCtx()
  if (!c || !master || c.state !== "running") return
  const now = c.currentTime
  const o = c.createOscillator()
  o.type = "square"
  o.frequency.value = 660
  const g = c.createGain()
  g.gain.setValueAtTime(0.0001, now)
  g.gain.exponentialRampToValueAtTime(0.16, now + 0.004)
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.13)
  o.connect(g).connect(master)
  o.start(now)
  o.stop(now + 0.15)
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
