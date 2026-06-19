// Player settings (sound + motion-sensor preference), persisted to localStorage
// so they survive reloads and are shared between the title menu and the game.
// Pure + framework-agnostic; the UI reads/writes through these helpers.

const STORAGE_KEY = "klossete:settings:v1"

export type Settings = {
  sound: boolean // wooden-clack + win sounds on?
  music: boolean // background OST on?
  tilt: boolean // use the device accelerometer (tilt) to drive gravity?
}

const DEFAULTS: Settings = { sound: true, music: true, tilt: false }

function load(): Settings {
  if (typeof window === "undefined") return { ...DEFAULTS }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const s = JSON.parse(raw) as Partial<Settings>
      return {
        sound: typeof s.sound === "boolean" ? s.sound : DEFAULTS.sound,
        music: typeof s.music === "boolean" ? s.music : DEFAULTS.music,
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

export function setTiltPref(on: boolean) {
  save({ ...load(), tilt: on })
}
