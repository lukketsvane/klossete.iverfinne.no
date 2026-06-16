// Realistic wooden-block impact sounds via modal synthesis (Web Audio API,
// no audio assets).
//
// A struck wooden block rings at a handful of *inharmonic* resonant modes that
// decay quickly, kicked off by a sharp contact transient. We pre-render that
// impulse response per block into a few buffers (variations, so repeated hits
// don't sound identical), then on each collision play one back through a
// velocity-driven low-pass: soft taps come out dull and muffled, hard knocks
// come out bright and cracky — which is what sells "this is solid wood."

let ctx: AudioContext | null = null
let master: GainNode | null = null
let muted = false
let lastPlay = 0

// id -> a few pre-rendered impulse variations
const buffers = new Map<string, AudioBuffer[]>()

function ensureCtx(): AudioContext | null {
  if (typeof window === "undefined") return null
  if (!ctx) {
    const AC: typeof AudioContext | undefined =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return null
    ctx = new AC()
    master = ctx.createGain()
    master.gain.value = 0.5
    master.connect(ctx.destination)
  }
  return ctx
}

export function unlockAudio() {
  const c = ensureCtx()
  if (c && c.state === "suspended") void c.resume()
}

export function setMuted(value: boolean) {
  muted = value
  if (!value) unlockAudio()
}

// Inharmonic modal series of a struck wooden bar/block: ratios relative to the
// fundamental, each with its own loudness and (short) decay time in seconds.
const MODES: { ratio: number; gain: number; decay: number }[] = [
  { ratio: 1.0, gain: 1.0, decay: 0.34 },
  { ratio: 2.41, gain: 0.6, decay: 0.2 },
  { ratio: 3.94, gain: 0.4, decay: 0.13 },
  { ratio: 6.1, gain: 0.25, decay: 0.085 },
  { ratio: 8.74, gain: 0.14, decay: 0.05 },
  { ratio: 11.9, gain: 0.08, decay: 0.032 },
]

function renderImpact(c: AudioContext, f0: number): AudioBuffer {
  const sr = c.sampleRate
  const dur = 0.55
  const len = Math.floor(sr * dur)
  const buf = c.createBuffer(1, len, sr)
  const data = buf.getChannelData(0)

  // Sum the decaying modal sinusoids. A small per-mode decay jitter and random
  // phase make each rendered variant subtly different.
  for (const m of MODES) {
    const w = 2 * Math.PI * f0 * m.ratio
    const decay = m.decay * (0.85 + Math.random() * 0.3)
    const phase = Math.random() * Math.PI * 2
    for (let n = 0; n < len; n++) {
      const t = n / sr
      data[n] += m.gain * Math.exp(-t / decay) * Math.sin(w * t + phase)
    }
  }

  // Contact transient: a very short noise burst, high-passed (one-pole diff) so
  // it reads as a crisp "tick" of two hard surfaces meeting rather than a thud.
  const tickDecay = 0.005
  let prev = 0
  for (let n = 0; n < len; n++) {
    const t = n / sr
    const white = Math.random() * 2 - 1
    const hp = white - prev
    prev = white
    data[n] += 0.6 * Math.exp(-t / tickDecay) * hp
  }

  // Normalize.
  let peak = 0
  for (let n = 0; n < len; n++) peak = Math.max(peak, Math.abs(data[n]))
  if (peak > 0) {
    const k = 0.92 / peak
    for (let n = 0; n < len; n++) data[n] *= k
  }
  return buf
}

/** Pre-render impulse variations for each block so the first hit has no hitch. */
export function primeBlocks(specs: { id: string; freq: number }[]) {
  const c = ensureCtx()
  if (!c) return
  for (const { id, freq } of specs) {
    if (buffers.has(id)) continue
    buffers.set(id, [renderImpact(c, freq), renderImpact(c, freq), renderImpact(c, freq)])
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

  const variants = buffers.get(id)
  if (!variants || variants.length === 0) return

  const now = c.currentTime
  if (now - lastPlay < 0.015) return
  lastPlay = now

  const v = Math.max(0, Math.min(1, strength))
  if (v < 0.02) return

  const src = c.createBufferSource()
  src.buffer = variants[(Math.random() * variants.length) | 0]
  src.playbackRate.value = 1 + (Math.random() * 0.08 - 0.04) // ±4% so hits vary

  // Harder hits excite more high-frequency energy: open the low-pass with v.
  const lp = c.createBiquadFilter()
  lp.type = "lowpass"
  lp.frequency.value = 600 + v * v * 8200
  lp.Q.value = 0.7

  const g = c.createGain()
  g.gain.value = Math.min(1, 0.12 + v)

  src.connect(lp).connect(g).connect(master)
  src.start()
}
