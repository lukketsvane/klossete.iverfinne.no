// Klossete Grand Prix — procedural track.
//
// The course is a single winding ribbon that descends through haze: gravity
// pulls the red can downhill and the player only steers left/right. Everything
// here is pure data + geometry (no React, no hooks) so the scene can build the
// road once and read the centreline samples for camera, respawns and pickups.
import * as THREE from "three"

const UP = new THREE.Vector3(0, 1, 0)

// Deterministic RNG so a given seed always yields the same course.
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type TrackSample = {
  p: THREE.Vector3 // centreline point on the road surface
  t: THREE.Vector3 // horizontal tangent (forward)
  r: THREE.Vector3 // banked right vector across the road
  n: THREE.Vector3 // banked road normal (up)
  bank: number
  dist: number // arc length from the start
}

export type Gate = { p: THREE.Vector3; left: THREE.Vector3; right: THREE.Vector3 }
export type Deco = { pos: [number, number, number]; size: [number, number, number]; rotY: number; shade: number }

export type Track = {
  samples: TrackSample[]
  geometry: THREE.BufferGeometry
  gates: Gate[]
  decos: Deco[]
  start: THREE.Vector3
  startDir: THREE.Vector3
  halfWidth: number
  length: number
}

const SEG = 4.0 // spacing between centreline samples
const COUNT = 360 // ~1440 units of road
const HALF_W = 5.5 // road half-width — a big, drivable course
const CURB_W = 1.2 // raised lip width either side
const CURB_H = 2.0 // lip height — a real wall that bounces the can back on

// Road + curb cross-section, as (across, height) pairs. The two middle points
// are the flat road; the outer two are the curb crests.
const PROFILE: [number, number][] = [
  [-(HALF_W + CURB_W), CURB_H],
  [-HALF_W, 0],
  [HALF_W, 0],
  [HALF_W + CURB_W, CURB_H],
]
const ROAD_COL = new THREE.Color("#e7ddca") // warm clay
const CURB_COL = new THREE.Color("#cfc6b4") // slightly greyer lip

export function buildTrack(seed = 7): Track {
  const rng = mulberry32(seed)
  const samples: TrackSample[] = []

  let heading = 0 // yaw in the XZ plane; 0 points toward -Z
  let bank = 0
  const p = new THREE.Vector3(0, 0, 0)
  let dist = 0

  for (let i = 0; i < COUNT; i++) {
    const s = i * SEG

    // Ease in (straight + flat) and ease out (flat run-off) at the ends.
    const intro = THREE.MathUtils.smoothstep(i, 0, 8)
    const outro = 1 - THREE.MathUtils.smoothstep(i, COUNT - 10, COUNT - 1)
    const active = intro * outro

    // Curvature as a sum of sines + a little noise → an unpredictable but smooth
    // weave. Capped so the radius never gets tighter than the can can hold.
    let curv = 0.05 * Math.sin(s * 0.020 + 1.0) + 0.034 * Math.sin(s * 0.057 + 3.0) + 0.02 * Math.sin(s * 0.011 + 0.4)
    curv += (rng() - 0.5) * 0.012
    curv *= active
    curv = THREE.MathUtils.clamp(curv, -0.06, 0.06) // flowing turns on a big course

    // Downhill grade — always present (so the can rolls from the line) and
    // breathing between shallow and steeper pitches further along. Kept lively
    // so gravity carries the can at a real clip, as in the reference.
    const grade = 0.1 + 0.05 * (0.5 + 0.5 * Math.sin(s * 0.03 + 2.0)) * outro

    // Bank into the curve so fast turns feel planted.
    const bankTarget = THREE.MathUtils.clamp(-curv * 3.2, -0.28, 0.28)
    bank = THREE.MathUtils.lerp(bank, bankTarget, 0.18)

    const t = new THREE.Vector3(Math.sin(heading), 0, -Math.cos(heading))
    const r = new THREE.Vector3().crossVectors(t, UP).normalize()
    const rb = r.clone().multiplyScalar(Math.cos(bank)).addScaledVector(UP, Math.sin(bank))
    const nb = UP.clone().multiplyScalar(Math.cos(bank)).addScaledVector(r, -Math.sin(bank))

    samples.push({ p: p.clone(), t, r: rb, n: nb, bank, dist })

    // Advance the centreline.
    p.addScaledVector(t, SEG)
    p.y -= grade * SEG
    heading += curv * SEG
    dist += SEG
  }

  // --- Ribbon geometry (road + curbs), one vertex-coloured trimesh ----------
  const positions: number[] = []
  const colors: number[] = []
  const indices: number[] = []
  for (const sm of samples) {
    for (const [a, h] of PROFILE) {
      const v = sm.p.clone().addScaledVector(sm.r, a).addScaledVector(sm.n, h)
      positions.push(v.x, v.y, v.z)
      const c = h > 0.01 ? CURB_COL : ROAD_COL
      colors.push(c.r, c.g, c.b)
    }
  }
  const PN = PROFILE.length
  for (let i = 0; i < samples.length - 1; i++) {
    const a = i * PN
    const b = (i + 1) * PN
    for (let k = 0; k < PN - 1; k++) {
      indices.push(a + k, a + k + 1, b + k + 1)
      indices.push(a + k, b + k + 1, b + k)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()

  // --- Flag gates (also act as respawn checkpoints) -------------------------
  const gates: Gate[] = []
  for (let i = 14; i < samples.length - 6; i += 26) {
    const sm = samples[i]
    const left = sm.p.clone().addScaledVector(sm.r, -(HALF_W + CURB_W)).addScaledVector(sm.n, CURB_H)
    const right = sm.p.clone().addScaledVector(sm.r, HALF_W + CURB_W).addScaledVector(sm.n, CURB_H)
    gates.push({ p: sm.p.clone(), left, right })
  }

  // --- Grey block scenery flanking the track (decorative only) --------------
  const decos: Deco[] = []
  for (let i = 6; i < samples.length - 4; i += 2) {
    const sm = samples[i]
    const sides = rng() < 0.5 ? [-1, 1] : [rng() < 0.5 ? -1 : 1]
    for (const side of sides) {
      if (rng() < 0.32) continue
      const off = HALF_W + CURB_W + 0.6 + rng() * 7
      const w = 1.4 + rng() * 3.4
      const d = 1.4 + rng() * 3.4
      const ht = 1.2 + rng() * 7
      const base = sm.p.clone().addScaledVector(sm.r, side * off)
      // sink the block a touch below the road so it reads as a wall/tower
      decos.push({
        pos: [base.x, base.y - 0.4 + ht / 2 - 1.0, base.z],
        size: [w, ht, d],
        rotY: (rng() - 0.5) * 0.5,
        shade: 0.62 + rng() * 0.22,
      })
    }
  }

  const start = samples[3].p.clone().addScaledVector(samples[3].n, 1.4)
  return {
    samples,
    geometry,
    gates,
    decos,
    start,
    startDir: samples[3].t.clone(),
    halfWidth: HALF_W,
    length: dist,
  }
}
