// Player settings (sound + motion-sensor preference), persisted to localStorage
// so they survive reloads and are shared between the title menu and the game.
// Pure + framework-agnostic; the UI reads/writes through these helpers.

const STORAGE_KEY = "klossete:settings:v1"

export type Settings = {
  sound: boolean // wooden-clack + win sounds on? (the in-game quick-mute)
  music: boolean // background OST playing? (the in-game quick-mute)
  soundVol: number // sound-effects volume 0..1 (the menu slider)
  musicVol: number // OST volume 0..1 (the menu slider)
  tilt: boolean // use the device accelerometer (tilt) to drive gravity?
}

const DEFAULTS: Settings = { sound: true, music: true, soundVol: 0.8, musicVol: 0.5, tilt: false }

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

function load(): Settings {
  if (typeof window === "undefined") return { ...DEFAULTS }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const s = JSON.parse(raw) as Partial<Settings>
      return {
        sound: typeof s.sound === "boolean" ? s.sound : DEFAULTS.sound,
        music: typeof s.music === "boolean" ? s.music : DEFAULTS.music,
        soundVol: typeof s.soundVol === "number" ? clamp01(s.soundVol) : DEFAULTS.soundVol,
        musicVol: typeof s.musicVol === "number" ? clamp01(s.musicVol) : DEFAULTS.musicVol,
        tilt: typeof s.tilt === "boolean" ? s.tilt : DEFAULTS.tilt,
      }
    }
  } catch {
    // ignore corrupt/blocked storage
  }
  return { ...DEFAULTS }
}

function save(s: Settings) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    // ignore quota/privacy errors
  }
}

export function getSettings(): Settings {
  return load()
}

export function setSound(on: boolean) {
  save({ ...load(), sound: on })
}

export function setMusic(on: boolean) {
  save({ ...load(), music: on })
}

export function setSoundVol(v: number) {
  save({ ...load(), soundVol: clamp01(v) })
}

export function setMusicVol(v: number) {
  save({ ...load(), musicVol: clamp01(v) })
}

export function setTiltPref(on: boolean) {
  save({ ...load(), tilt: on })
}
