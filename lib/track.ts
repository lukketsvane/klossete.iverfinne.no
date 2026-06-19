// KLOSSETE GRAND PRIX — the course.
//
// A winding road DOWNHILL through the fog. The centreline is a hand-authored
// descending spline; we smooth it into a ribbon of short box segments (floor +
// side rails). The ramps are placed along the SAME spline and baked into the
// floor's collision mesh as smooth wedges, so the cylinder rolls onto them
// without ever hitting a separate, pinch-prone collider. Gravity does most of
// the work — you steer the roll down the hill, checkpoint to checkpoint.
import * as THREE from "three"

export type Vec3 = [number, number, number]
export type Quat = [number, number, number, number]
// A placed box: centre, Euler rotation, and full length along its local X.
export type Piece = { pos: Vec3; rot: Vec3; len: number }
export type Checkpoint = { pos: Vec3; rot: Vec3; index: number; finish: boolean }
// A ramp GLB placed on the ribbon. `pos`/`quat`/`scale` drive the visual mesh;
// `dims` are the scaled bounding size used to bake a matching wedge into the
// collision floor.
export type Feature = { url: string; pos: Vec3; quat: Quat; scale: Vec3; dims: Vec3 }

export const TRACK_WIDTH = 4.6
export const FLOOR_THICK = 1.0
export const RAIL_HEIGHT = 1.0
export const RAIL_THICK = 0.4
export const FALL_Y = -14 // below the lowest point of the course → respawn

// Native bounding sizes of each ramp GLB (width X, height Y from base, depth Z).
export const RAMP_NATIVE: Record<string, Vec3> = {
  "/models/ramp_01.glb": [0.998, 0.545, 0.557],
  "/models/ramp_02.glb": [0.998, 0.502, 0.58],
  "/models/ramp_03.glb": [0.998, 0.631, 0.627],
  "/models/ramp_04.glb": [0.998, 0.545, 0.557],
}

// The descending serpentine: starts high, winds back and forth all the way down.
const CONTROL: Vec3[] = [
  [0, 22, 0],
  [1, 21, 9],
  [7, 19.5, 14],
  [14, 18, 12],
  [18, 16.5, 4],
  [15, 15, -4],
  [7, 13.5, -6],
  [0, 12, -1],
  [-3, 10.5, 7],
  [1, 9, 15],
  [9, 7.5, 18],
  [16, 6, 14],
  [18, 4.5, 6],
  [13, 3, 0],
  [5, 1.8, -1],
  [-2, 0.8, 4],
  [-6, 0, 12],
]

const UP = new THREE.Vector3(0, 1, 0)

// Build one box transform spanning p0→p1: centre at the midpoint, local X along
// the segment, local Y as the surface normal (so the ribbon banks with the hill).
function pieceBetween(p0: THREE.Vector3, p1: THREE.Vector3, lift: number, alongRight: number): Piece {
  const forward = new THREE.Vector3().subVectors(p1, p0)
  const len = forward.length()
  forward.normalize()
  const right = new THREE.Vector3().crossVectors(UP, forward)
  if (right.lengthSq() < 1e-6) right.set(1, 0, 0)
  right.normalize()
  const up = new THREE.Vector3().crossVectors(forward, right).normalize()

  const mid = new THREE.Vector3().addVectors(p0, p1).multiplyScalar(0.5)
  mid.addScaledVector(up, lift)
  mid.addScaledVector(right, alongRight)

  const m = new THREE.Matrix4().makeBasis(forward, up, right)
  const rot = new THREE.Euler().setFromRotationMatrix(m)
  return { pos: [mid.x, mid.y, mid.z], rot: [rot.x, rot.y, rot.z], len }
}

function buildTrack() {
  const curve = new THREE.CatmullRomCurve3(
    CONTROL.map((c) => new THREE.Vector3(...c)),
    false,
    "catmullrom",
    0.5,
  )
  const SAMPLES = 160
  const pts = curve.getSpacedPoints(SAMPLES)

  const floor: Piece[] = []
  const rails: Piece[] = []
  const half = TRACK_WIDTH / 2
  const railOffset = half + RAIL_THICK / 2
  const railLift = FLOOR_THICK / 2 + RAIL_HEIGHT / 2 - 0.05

  for (let i = 0; i < pts.length - 1; i++) {
    floor.push(pieceBetween(pts[i], pts[i + 1], 0, 0))
    rails.push(pieceBetween(pts[i], pts[i + 1], railLift, railOffset))
    rails.push(pieceBetween(pts[i], pts[i + 1], railLift, -railOffset))
  }

  // Checkpoints spread along the curve; the last is the finish.
  const CP_FRACTIONS = [0.0, 0.22, 0.44, 0.66, 0.85, 1.0]
  const checkpoints: Checkpoint[] = CP_FRACTIONS.map((f, index) => {
    const t = Math.min(0.999, Math.max(0.001, f))
    const p = curve.getPointAt(t)
    const tan = curve.getTangentAt(t)
    const yaw = Math.atan2(tan.x, tan.z)
    return {
      pos: [p.x, p.y + FLOOR_THICK / 2, p.z] as Vec3,
      rot: [0, yaw, 0] as Vec3,
      index,
      finish: f === 1.0,
    }
  })

  // Ramps placed along the spline. Oriented to the surface so the base lies flush
  // on the (descending) ribbon, and turned so the cylinder rolls UP the slope in
  // its travel direction. The GLB rises along its local -Z, so we align local -Z
  // with travel and local +Y with the surface normal.
  const RAMP_SPECS: { url: string; t: number; scale: Vec3 }[] = [
    { url: "/models/ramp_01.glb", t: 0.12, scale: [3.4, 1.3, 3.4] },
    { url: "/models/ramp_03.glb", t: 0.24, scale: [3.4, 1.5, 3.8] },
    { url: "/models/ramp_02.glb", t: 0.35, scale: [3.4, 1.3, 3.4] },
    { url: "/models/ramp_04.glb", t: 0.47, scale: [3.4, 1.5, 3.8] },
    { url: "/models/ramp_01.glb", t: 0.57, scale: [3.4, 1.2, 3.2] },
    { url: "/models/ramp_03.glb", t: 0.68, scale: [3.4, 1.5, 3.8] },
    { url: "/models/ramp_02.glb", t: 0.78, scale: [3.4, 1.3, 3.4] },
    { url: "/models/ramp_04.glb", t: 0.9, scale: [3.4, 1.4, 3.4] },
  ]
  const features: Feature[] = RAMP_SPECS.map((spec) => {
    const t = Math.min(0.999, Math.max(0.001, spec.t))
    const p = curve.getPointAt(t)
    const tan = curve.getTangentAt(t).normalize()
    const right = new THREE.Vector3().crossVectors(UP, tan)
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0)
    right.normalize()
    const up = new THREE.Vector3().crossVectors(tan, right).normalize()
    // GLB local axes → world: X(width)→right, Y(up)→up, Z→ -travel (high side faces travel)
    const back = tan.clone().multiplyScalar(-1)
    const m = new THREE.Matrix4().makeBasis(right, up, back)
    const q = new THREE.Quaternion().setFromRotationMatrix(m)
    const native = RAMP_NATIVE[spec.url]
    const surfacePos = new THREE.Vector3(p.x, p.y, p.z).addScaledVector(up, FLOOR_THICK / 2)
    return {
      url: spec.url,
      pos: [surfacePos.x, surfacePos.y, surfacePos.z] as Vec3,
      quat: [q.x, q.y, q.z, q.w] as Quat,
      scale: spec.scale,
      dims: [native[0] * spec.scale[0], native[1] * spec.scale[1], native[2] * spec.scale[2]] as Vec3,
    }
  })

  const start = checkpoints[0]

  // A scatter of distant background blocks for the foggy skyline (visual only).
  const blocks: { pos: Vec3; size: Vec3; rot: number }[] = []
  let seed = 7
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280
    return seed / 233280
  }
  for (let i = 0; i < 80; i++) {
    const ang = rand() * Math.PI * 2
    const dist = 30 + rand() * 60
    const cx = Math.cos(ang) * dist
    const cz = Math.sin(ang) * dist + 8
    const w = 2 + rand() * 5
    const h = 4 + rand() * 16
    const d = 2 + rand() * 5
    blocks.push({ pos: [cx, h / 2 + rand() * 6, cz], size: [w, h, d], rot: rand() * Math.PI })
  }

  return { floor, rails, checkpoints, start, blocks, features }
}

export const TRACK = buildTrack()
