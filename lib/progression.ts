// Linear level progression — the backbone for "solve the secret to advance".
//
// Tracks which level you're on and which you've solved, persisted to
// localStorage so progress survives reloads. Pure + framework-agnostic; the
// engine wires it up (mark a level solved on win, then advance). Introduced in
// Phase 3; wired into the game in a later phase (see docs/ARCHITECTURE.md).

const STORAGE_KEY = "klossete:progress:v1"

export type Progress = {
  current: number // index into the level order
  solved: string[] // ids of solved levels
}

const EMPTY: Progress = { current: 0, solved: [] }

function load(): Progress {
  if (typeof window === "undefined") return { ...EMPTY }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<Progress>
      return { current: p.current ?? 0, solved: Array.isArray(p.solved) ? p.solved : [] }
    }
  } catch {
    // ignore corrupt/blocked storage
  }
  return { ...EMPTY }
}

function save(p: Progress) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
  } catch {
    // ignore quota/privacy errors
  }
}

export function getProgress(): Progress {
  return load()
}

export function isSolved(id: string): boolean {
  return load().solved.includes(id)
}

/** Record a level as solved (idempotent). */
export function markSolved(id: string) {
  const p = load()
  if (!p.solved.includes(id)) {
    p.solved.push(id)
    save(p)
  }
}

/** Set the active level index (clamped by the caller to the level count). */
export function setCurrent(index: number) {
  const p = load()
  p.current = Math.max(0, index)
  save(p)
}

/** Advance to the next level, capped at `count - 1`. Returns the new index. */
export function advance(count: number): number {
  const p = load()
  p.current = Math.min(p.current + 1, Math.max(0, count - 1))
  save(p)
  return p.current
}

export function resetProgress() {
  save({ ...EMPTY })
}
