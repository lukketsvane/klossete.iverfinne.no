// Realistic wooden-block impact sounds via lightweight modal + noise synthesis
// (Web Audio API, no audio assets).
//
// Real hardwood-on-hardwood is a dry "clack", not a ringing tone: a sharp
// broadband contact transient, a band-passed mid "knock" body, and only a
// brief low resonance that damps almost immediately. We pre-render that impulse
// per block into a few buffers (variations), then on each collision play one
// through a velocity-driven low-pass — soft taps come out dull, hard knocks
// crack — which is what sells solid wood.

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
    master.gain.value = 0.55
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

// A short, well-damped modal body. Decays are tiny (tens of ms) so the result
// reads as a dry knock rather than a tuned bar.
const MODES: { ratio: number; gain: number; decay: number }[] = [
  { ratio: 1.0, gain: 0.7, decay: 0.07 },
  { ratio: 2.18, gain: 0.32, decay: 0.045 },
  { ratio: 3.7, gain: 0.16, decay: 0.03 },
]

// One-pass 2nd-order band-pass (RBJ cookbook) used to colour the noise "knock".
function bandpass(input: Float32Array, sr: number, freq: number, Q: number) {
  const w0 = (2 * Math.PI * freq) / sr
  const cw = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * Q)
  const a0 = 1 + alpha
  const b0 = alpha / a0
  const b2 = -alpha / a0
  const a1 = (-2 * cw) / a0
  const a2 = (1 - alpha) / a0
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let n = 0; n < input.length; n++) {
    const x = input[n]
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y
    input[n] = y
  }
}

function renderImpact(c: AudioContext, f0: number): AudioBuffer {
  const sr = c.sampleRate
  const dur = 0.2
  const len = Math.floor(sr * dur)
  const buf = c.createBuffer(1, len, sr)
  const data = buf.getChannelData(0)

  // Modal body – short decaying sinusoids for a touch of pitch.
  for (const m of MODES) {
    const w = 2 * Math.PI * f0 * m.ratio
    const decay = m.decay * (0.85 + Math.random() * 0.3)
    const phase = Math.random() * Math.PI * 2
    for (let n = 0; n < len; n++) {
      const t = n / sr
      data[n] += m.gain * Math.exp(-t / decay) * Math.sin(w * t + phase)
    }
  }

  // Band-passed noise "knock" – the woody dry body of the clack.
  const knock = new Float32Array(len)
  for (let n = 0; n < len; n++) knock[n] = Math.random() * 2 - 1
  bandpass(knock, sr, f0 * 3.2, 1.1)
  for (let n = 0; n < len; n++) {
    const t = n / sr
    data[n] += 0.8 * Math.exp(-t / 0.022) * knock[n]
  }

  // Bright contact tick – a very short high-passed noise transient.
  let prev = 0
  for (let n = 0; n < len; n++) {
    const t = n / sr
    const white = Math.random() * 2 - 1
    const hp = white - prev
    prev = white
    data[n] += 0.5 * Math.exp(-t / 0.0022) * hp
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
  lp.frequency.value = 800 + v * v * 9000
  lp.Q.value = 0.6

  const g = c.createGain()
  g.gain.value = Math.min(1, 0.14 + v)

  src.connect(lp).connect(g).connect(master)
  src.start()
}
