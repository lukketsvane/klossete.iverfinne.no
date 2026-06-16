// Camera + tray layout – the single source of truth.
//
// The camera looks straight down at the origin, so the visible floor is an
// axis-aligned rectangle centred on (0,0). We derive its half extents
// analytically (no raycasting), build a clean rectangular tray from them, and
// reuse the EXACT same numbers to clamp dragging and to catch any body that
// escapes – so the box, the camera and the containment logic never drift apart.

export const CAM_FOV = 36

// How many world units to keep visible. Smaller = camera tighter = blocks read
// BIGGER on screen. Phones get a tighter frame so the blocks aren't tiny.
const TARGET_HALF_DESKTOP = 4.4
export function viewTarget(w: number, h: number) {
  const min = Math.min(w, h)
  if (min < 520) return 2.8 // phones
  if (min < 820) return 3.6 // small tablets
  return TARGET_HALF_DESKTOP
}

const BOX_INSET = 0.9 // pull the walls inward so the whole frame reads on screen
const WALL_HALF_THICK = 0.4
export const WALL_VIS_HEIGHT = 3.0 // the wood-coloured tray walls you actually see
export const WALL_COL_HEIGHT = 16 // invisible containment walls – a deep box nothing escapes
export const FLOOR = 120 // size of the (room) floor plane

// Half extents of the inner wall faces: the playable rectangle on the floor.
export type Box = { bx: number; bz: number }

export function boxLayout(aspect: number, target: number) {
  const halfV = Math.tan((CAM_FOV / 2) * (Math.PI / 180))
  const dist = Math.max(target / (halfV * aspect), target / halfV) + 0.5
  const halfX = dist * halfV * aspect
  const halfZ = dist * halfV
  return { dist, bx: halfX * BOX_INSET, bz: halfZ * BOX_INSET }
}

export type Wall = { half: [number, number, number]; pos: [number, number, number] }

// Four axis-aligned walls whose inner faces sit exactly on ±bx / ±bz.
export function buildWalls({ bx, bz }: Box, height: number): Wall[] {
  const t = WALL_HALF_THICK
  const h = height / 2
  return [
    { half: [t, h, bz + 2 * t], pos: [-(bx + t), h, 0] }, // left
    { half: [t, h, bz + 2 * t], pos: [bx + t, h, 0] }, // right
    { half: [bx + 2 * t, h, t], pos: [0, h, -(bz + t)] }, // back
    { half: [bx + 2 * t, h, t], pos: [0, h, bz + t] }, // front
  ]
}
