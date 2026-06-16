// Procedural "wooden block" impact sounds via the Web Audio API – no audio
// assets required. Each hit is a short percussive knock: a couple of decaying
// resonant partials (the woody body) plus a filtered noise transient (the
// contact "tock"). Volume tracks impact strength; pitch tracks block size.

let ctx: AudioContext | null = null
let master: GainNode | null = null
let muted = false
let lastPlay = 0

function ensureCtx(): AudioContext | null {
  if (typeof window === "undefined") return null
  if (!ctx) {
    const AC: typeof AudioContext | undefined =
      window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return null
    ctx = new AC()
    master = ctx.createGain()
    master.gain.value = 0.55
    master.connect(ctx.destination)
  }
  return ctx
}

/** Resume the audio context from a user gesture (required by browsers). */
export function unlockAudio() {
  const c = ensureCtx()
  if (c && c.state === "suspended") void c.resume()
}

export function setMuted(value: boolean) {
  muted = value
  if (!value) unlockAudio()
}

/**
 * Play one wooden impact.
 * @param strength 0..1 – how hard the hit was (maps to loudness)
 * @param pitch    multiplier on the base frequency (smaller block -> higher)
 */
export function playImpact(strength: number, pitch = 1) {
  if (muted) return
  const c = ensureCtx()
  if (!c || !master || c.state !== "running") return

  const now = c.currentTime
  if (now - lastPlay < 0.018) return // throttle dense contact bursts
  lastPlay = now

  const v = Math.max(0, Math.min(1, strength))
  if (v < 0.02) return

  const base = 200 * pitch

  // Woody body: a fundamental plus an inharmonic partial, each decaying fast.
  const partials = [
    { mul: 1, gain: 0.6, decay: 0.19 },
    { mul: 2.76, gain: 0.22, decay: 0.12 },
  ]
  for (const p of partials) {
    const osc = c.createOscillator()
    osc.type = "sine"
    osc.frequency.value = base * p.mul * (0.99 + Math.random() * 0.02)
    const g = c.createGain()
    const peak = v * p.gain
    g.gain.setValueAtTime(0.0001, now)
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), now + 0.003)
    g.gain.exponentialRampToValueAtTime(0.0001, now + p.decay)
    osc.connect(g).connect(master)
    osc.start(now)
    osc.stop(now + p.decay + 0.02)
  }

  // Contact transient: a short, quickly-decaying band-passed noise burst.
  const dur = 0.045
  const len = Math.max(1, Math.ceil(c.sampleRate * dur))
  const buf = c.createBuffer(1, len, c.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < len; i++) {
    const env = 1 - i / len
    data[i] = (Math.random() * 2 - 1) * env * env
  }
  const noise = c.createBufferSource()
  noise.buffer = buf
  const bp = c.createBiquadFilter()
  bp.type = "bandpass"
  bp.frequency.value = base * 3
  bp.Q.value = 0.7
  const ng = c.createGain()
  ng.gain.value = v * 0.5
  noise.connect(bp).connect(ng).connect(master)
  noise.start(now)
  noise.stop(now + dur)
}
