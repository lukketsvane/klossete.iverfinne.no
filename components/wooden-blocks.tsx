"use client"

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Canvas, useThree, useFrame } from "@react-three/fiber"
import { ContactShadows, Html, MeshReflectorMaterial, useGLTF, useTexture } from "@react-three/drei"
import {
  Physics,
  RigidBody,
  CuboidCollider,
  CylinderCollider,
  useRapier,
  type RapierRigidBody,
} from "@react-three/rapier"
import * as THREE from "three"
import { LayoutGrid, Smartphone, Volume2, VolumeX } from "lucide-react"
import { audioReady, playBeep, playImpact, playTone, primeBlocks, setMuted, unlockAudio } from "@/lib/impact-sound"
import { BLOCKS, MESH_FIT, blockBaseFreq, blockRadius, type Block } from "@/lib/blocks"
import { CameraRig } from "@/components/engine/CameraRig"
import { PostFx } from "@/components/engine/PostFx"
import { CRT_VERT, CRT_FRAG, PEEL_FRAG, MISS_FRAG, GRID_FRAG } from "@/components/rooms/shaders"
import { getProgress, markSolved, setCurrent } from "@/lib/progression"
import { setSound, setTiltPref } from "@/lib/settings"
import {
  CAM_FOV,
  FLOOR,
  WALL_COL_HEIGHT,
  WALL_VIS_HEIGHT,
  boxLayout,
  buildWalls,
  viewTarget,
  type Box,
  type Wall,
} from "@/lib/layout"

/* ------------------------------------------------------------------ */
/*  Rapier body-type constants (avoid importing the wasm enum)         */
/* ------------------------------------------------------------------ */
const BODY_DYNAMIC = 0
const BODY_KINEMATIC_POSITION = 2

/* ------------------------------------------------------------------ */
/*  Shared device-tilt state (written by DOM listener, read in 3D)     */
/* ------------------------------------------------------------------ */
type TiltState = {
  enabled: boolean
  beta: number // front-back tilt in degrees
  gamma: number // left-right tilt in degrees
  sx: number // calibrated screen-right gravity component (-1..1)
  sz: number // calibrated screen-down gravity component (-1..1)
}



function useBox(): Box {
  const size = useThree((s) => s.size)
  return useMemo(() => {
    const { bx, bz } = boxLayout(size.width / size.height, viewTarget(size.width, size.height))
    return { bx, bz }
  }, [size.width, size.height])
}



function BlockMesh({
  block,
  onPointerDown,
  flat = false,
  revealRef,
}: {
  block: Block
  onPointerDown: (e: any) => void
  flat?: boolean // projection room: render colourless until solved
  revealRef?: React.MutableRefObject<boolean>
}) {
  const gltf = useGLTF(block.mesh.url)
  const model = useMemo(() => {
    const clone = gltf.scene.clone(true)
    clone.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.castShadow = true
      mesh.receiveShadow = true
    })
    return clone
  }, [gltf.scene])

  // Original materials + a flat dark "colourless" stand-in for the projection room.
  const originals = useMemo(() => {
    const map = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>()
    model.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) map.set(m, m.material)
    })
    return map
  }, [model])
  // fully invisible (but still grabbable) stand-in for the projection room
  const flatMat = useMemo(
    () => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    [],
  )
  const state = useRef<"flat" | "real" | null>(null)
  useFrame(() => {
    const want = flat && !revealRef?.current ? "flat" : "real"
    if (want === state.current) return
    state.current = want
    const real = want === "real"
    model.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      m.material = real ? originals.get(m) ?? m.material : flatMat
      m.castShadow = real // invisible pieces must not cast ghost shadows
      m.receiveShadow = real
    })
  })

  return (
    <group onPointerDown={onPointerDown} scale={MESH_FIT}>
      <primitive object={model} dispose={null} />
    </group>
  )
}

/* ------------------------------------------------------------------ */
/*  A single draggable / throwable block                               */
/* ------------------------------------------------------------------ */
function BlockBody({
  block,
  bodyRef,
  onGrab,
  onImpact,
  knock,
  showAfterimage,
  flat,
  revealRef,
  measureMode,
  selected,
  onSelect,
}: {
  block: Block
  bodyRef: (b: RapierRigidBody | null) => void
  onGrab: (body: RapierRigidBody, point: THREE.Vector3, block: Block) => void
  onImpact: (x: number, z: number, strength: number) => void
  knock: boolean // play the wooden clack? (off in the music-tile env)
  showAfterimage: boolean
  flat?: boolean // projection room: colourless until solved
  revealRef?: React.MutableRefObject<boolean>
  measureMode: boolean
  selected: boolean
  onSelect: (id: string) => void
}) {
  const ref = useRef<RapierRigidBody>(null)

  const handlePointerDown = (e: any) => {
    e.stopPropagation()
    if (!ref.current) return
    if (measureMode) {
      onSelect(block.id)
      return
    }
    onGrab(ref.current, e.point.clone(), block)
  }

  const labelY = block.shape === "cylinder" ? block.halfHeight + 0.5 : block.half[1] + 0.5

  const handleImpact = (payload: {
    target: { rigidBody?: RapierRigidBody }
    other: { rigidBody?: RapierRigidBody }
  }) => {
    const a = payload.target.rigidBody
    if (!a) return
    const av = a.linvel()
    let speed = Math.hypot(av.x, av.y, av.z)
    const b = payload.other.rigidBody
    if (b) {
      const bv = b.linvel()
      speed = Math.max(speed, Math.hypot(bv.x, bv.y, bv.z))
    }
    const strength = THREE.MathUtils.clamp((speed - 0.45) / 7, 0, 1)
    if (strength > 0) {
      if (knock) playImpact(block.id, strength) // wooden clack (silenced in the music env)
      const t = a.translation()
      onImpact(t.x, t.z, strength) // light up / play the tile it struck
      impactHaptic(strength) // and let you feel the knock
    }
  }

  return (
    <RigidBody
      ref={(r) => {
        ref.current = r
        bodyRef(r)
      }}
      position={block.pos}
      rotation={block.rot}
      colliders={false}
      // hardwood feel: grippy wood-on-wood friction, a small hard clack of
      // restitution, and a uniform dense-hardwood density so mass scales with
      // volume (the cylinder lands heavier than the little cube). Low damping
      // keeps them lively rather than floating through air.
      friction={0.7}
      restitution={0.1}
      density={6}
      linearDamping={0.2}
      angularDamping={1.1}
      canSleep={false}
      onCollisionEnter={handleImpact}
      ccd
    >
      {block.shape === "box" ? (
        <>
          <CuboidCollider args={block.half} />
          <BlockMesh block={block} onPointerDown={handlePointerDown} flat={flat} revealRef={revealRef} />
        </>
      ) : (
        <>
          <CylinderCollider args={[block.halfHeight, block.radius]} />
          <BlockMesh block={block} onPointerDown={handlePointerDown} flat={flat} revealRef={revealRef} />
        </>
      )}

      {showAfterimage && <Afterimage block={block} />}
    </RigidBody>
  )
}

/* ------------------------------------------------------------------ */
/*  Tilt controller – maps device orientation to gravity + light       */
/* ------------------------------------------------------------------ */
// Gravity tuned so blocks settle with weight but stay calm enough to stack
// without bouncing themselves over (too strong made them impossible to build with).
const G = 20

// Default resting position of the warm key light. The camera looks straight
// down with screen-up mapped to -z, so a light on the -z side reads as coming
// from the TOP of the page (shadows fall down-screen). A small -x bias keeps a
// touch of form. Shift+right-drag re-aims it; tilt swings it around this anchor.
const KEY = { x: -6, y: 18, z: -5 }

// A subtle low-contrast value-noise texture used to break the perfectly-flat
// roughness of the floor and tray walls (material imperfection).
function makeNoiseTexture(size = 128): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4)
  // two-octave smoothed noise for a gentle, non-uniform grain
  const coarse = new Float32Array(size * size)
  for (let i = 0; i < coarse.length; i++) coarse[i] = Math.random()
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x
      const xr = (x + 1) % size
      const yd = ((y + 1) % size) * size
      const smooth = (coarse[i] + coarse[y * size + xr] + coarse[yd + x] + coarse[yd + xr]) / 4
      const v = 205 + (smooth * 0.6 + Math.random() * 0.4) * 50
      data[i * 4] = v
      data[i * 4 + 1] = v
      data[i * 4 + 2] = v
      data[i * 4 + 3] = 255
    }
  }
  const tex = new THREE.DataTexture(data, size, size)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(6, 6)
  tex.needsUpdate = true
  return tex
}

/* ------------------------------------------------------------------ */
/*  Procedural tile textures (one cell per texture; tiled via repeat)  */
/*  used by the gold-mirror and glass-block environments.              */
/* ------------------------------------------------------------------ */

// Thin bright grid lines on black – glowing seams / mortar (emissive map).
function makeSeamTexture(size = 256, line = 0.045): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size
      const v = y / size
      const d = Math.min(u, 1 - u, v, 1 - v)
      const on = d < line ? 255 : 0
      const i = (y * size + x) * 4
      data[i] = data[i + 1] = data[i + 2] = on
      data[i + 3] = 255
    }
  }
  const tex = new THREE.DataTexture(data, size, size)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  return tex
}

// Pillowed-square normal map: each tile bulges like a glass brick, with a
// mortar groove at the borders (where neighbouring tiles meet under repeat).
function makeBrickNormalTexture(size = 256, bevel = 0.16, strength = 2.2): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size
      const v = y / size
      const dx = Math.min(u, 1 - u)
      const dy = Math.min(v, 1 - v)
      const sx = dx < bevel ? (1 - dx / bevel) * (u < 0.5 ? -1 : 1) : 0
      const sy = dy < bevel ? (1 - dy / bevel) * (v < 0.5 ? -1 : 1) : 0
      let nx = sx * strength
      let ny = sy * strength
      let nz = 1
      const inv = 1 / Math.hypot(nx, ny, nz)
      nx *= inv
      ny *= inv
      nz *= inv
      const i = (y * size + x) * 4
      data[i] = Math.round(nx * 127.5 + 127.5)
      data[i + 1] = Math.round(ny * 127.5 + 127.5)
      data[i + 2] = Math.round(nz * 127.5 + 127.5)
      data[i + 3] = 255
    }
  }
  const tex = new THREE.DataTexture(data, size, size)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.needsUpdate = true
  return tex
}

// Backlight glow for glass bricks: bright cell interior, darker at the mortar.
function makeBrickGlowTexture(size = 256, bevel = 0.16): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size
      const v = y / size
      const d = Math.min(u, 1 - u, v, 1 - v)
      const e = d < bevel ? 0.4 + 0.6 * (d / bevel) : 1
      const val = Math.round(e * 255)
      const i = (y * size + x) * 4
      data[i] = data[i + 1] = data[i + 2] = val
      data[i + 3] = 255
    }
  }
  const tex = new THREE.DataTexture(data, size, size)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  return tex
}

/* ------------------------------------------------------------------ */
/*  Environments – cycle with number keys 1-9 (desktop) or a two-finger */
/*  tap-and-hold (touch). Each swaps the room materials + lighting mood. */
/* ------------------------------------------------------------------ */
type EnvKind =
  | "concrete"
  | "gold"
  | "glass"
  | "playmat"
  | "video"
  | "peel"
  | "texturemiss"
  | "fourthside"
  | "klossete"
  | "projection"
  | "magnet"
  | "maze"
type EnvConfig = {
  id: string
  look?: EnvKind // which room's visuals to render (defaults to a matching id)
  name: string
  bg: string // canvas + page background
  keyColor: string
  keyIntensity: number
  contact: { color: string; opacity: number } // grounding contact shadow
  bloom: boolean
  reactive?: boolean // tiles flash with light where a block hits (brightness ~ force)
  fourthSide?: boolean // wraps each block in glowing wireframe "4D" shells
  puzzle?: boolean // sort each block onto its zone -> they blink "KLOSSETE" in Morse
  projection?: boolean // shapes are flat/colourless until their floor projections
  // are arranged onto the target outline – then the 3D forms appear in colour
  magnet?: boolean // zero-g: pieces gently magnet-snap (each to one partner) into a totem
  maze?: boolean // a single block "flip-flop" tips through a camera-following maze to an exit
  gather?: boolean // bring every block onto the glowing pad to solve
  stack?: boolean // stack a block up through the glowing ring to solve
  corners?: boolean // rest a block in each lit corner
  lineup?: boolean // line all five blocks along the glowing centre line
  plate?: boolean // rest a block on the glowing plate
  apart?: boolean // scatter every block out of the centre ring to solve
  five?: boolean // bring each block to its glowing slot -> build the Messias figure
  solo?: string // a one-block stage: pilot just this block (by id) to the exit
  mosaic?: number // which mosaic floor (1-4) a solo stage stands on
}
const BASE_ENVIRONMENTS: EnvConfig[] = [
  {
    id: "concrete",
    name: "Concrete",
    bg: "#cdc6b8",
    keyColor: "#fff1df",
    keyIntensity: 3.1,
    contact: { color: "#332b20", opacity: 0.5 },
    bloom: false,
    stack: true, // key: stack a block up through the glowing ring
  },
  {
    id: "gold",
    name: "Gold mirror",
    bg: "#0c0a06",
    keyColor: "#ffdca0",
    keyIntensity: 2.4,
    contact: { color: "#000000", opacity: 0.35 },
    bloom: true,
    gather: true, // key: gather all five blocks onto the glowing pad
  },
  {
    id: "glass",
    name: "Glass blocks",
    bg: "#eef2f6",
    keyColor: "#ffffff",
    keyIntensity: 2.7,
    contact: { color: "#3a4452", opacity: 0.28 },
    bloom: true,
    reactive: true, // each glass tile lights up where a block strikes it
    corners: true, // key: rest a block in each lit corner
  },
  {
    id: "playmat",
    name: "Play mat",
    bg: "#e7e0ec",
    keyColor: "#fff4ea",
    keyIntensity: 2.5,
    contact: { color: "#5a4f63", opacity: 0.34 },
    bloom: false,
    lineup: true, // key: line all five blocks along the centre line
  },
  {
    id: "video",
    name: "Video room",
    bg: "#000000",
    keyColor: "#ffffff",
    keyIntensity: 1.5,
    contact: { color: "#000000", opacity: 0.45 },
    bloom: true,
    plate: true, // key: rest a block on the glowing plate
  },
  {
    id: "peel",
    name: "Reality peel",
    bg: "#cbc6b9",
    keyColor: "#fff4e6",
    keyIntensity: 2.2,
    contact: { color: "#37332a", opacity: 0.3 },
    bloom: false,
    apart: true, // key: scatter the blocks out of the centre ring ("uncover")
  },
  {
    id: "texturemiss",
    name: "Texture not found",
    bg: "#060609",
    keyColor: "#ffffff",
    keyIntensity: 1.8,
    contact: { color: "#000000", opacity: 0.4 },
    bloom: true,
    corners: true, // key: rest a block in each lit corner
  },
  {
    id: "fourthside",
    name: "The Fourth Side",
    bg: "#03050a",
    keyColor: "#cfe6ff",
    keyIntensity: 1.4,
    contact: { color: "#0b2f3a", opacity: 0.55 }, // cold, sharp 2D projection on the floor
    bloom: true, // makes the wireframe shells glow like TRON
    fourthSide: true,
    lineup: true, // key: line the blocks along the centre line
  },
  {
    id: "klossete",
    name: "klossete",
    bg: "#0e0f13",
    keyColor: "#ffffff",
    keyIntensity: 1.6,
    contact: { color: "#000000", opacity: 0.4 },
    bloom: true, // the win flash blooms like real lightbulbs
    puzzle: true,
  },
  {
    id: "projection",
    name: "Projection",
    bg: "#0a0b0e",
    keyColor: "#ffffff",
    keyIntensity: 1.2,
    contact: { color: "#000000", opacity: 0.0 }, // the only "shadow" is the colour projection
    bloom: true, // the reveal flash blooms
    projection: true,
  },
  {
    id: "magnet",
    name: "Magnets",
    bg: "#04050a",
    keyColor: "#fff3e0", // a hard, sharp sun
    keyIntensity: 4.6,
    contact: { color: "#000000", opacity: 0.0 }, // floating in space – no floor shadow
    bloom: true, // the magnetic tethers + solve flash glow + the sun glare
    magnet: true,
  },
  {
    id: "maze",
    name: "Maze",
    bg: "#05070d",
    keyColor: "#cfe0ff",
    keyIntensity: 1.4,
    contact: { color: "#000000", opacity: 0.0 }, // the maze room lights itself
    bloom: true, // the exit + solve flash glow
    maze: true,
  },
  {
    id: "solo-cylinder",
    name: "Cylinder",
    bg: "#0c0b0a",
    keyColor: "#fff1dc",
    keyIntensity: 1.8,
    contact: { color: "#000000", opacity: 0.4 },
    bloom: true,
    solo: "cylinder", // pilot just the red cylinder (it rolls) to the exit
    mosaic: 4,
  },
  {
    id: "solo-plank-long",
    name: "Long plank",
    bg: "#0b0c0a",
    keyColor: "#eaf0ff",
    keyIntensity: 1.8,
    contact: { color: "#000000", opacity: 0.4 },
    bloom: true,
    solo: "plank-long", // the long blue plank tumbles end-over-end
    mosaic: 1,
  },
  {
    id: "solo-plank-short",
    name: "Short plank",
    bg: "#0a0b0c",
    keyColor: "#eaf0ff",
    keyIntensity: 1.8,
    contact: { color: "#000000", opacity: 0.4 },
    bloom: true,
    solo: "plank-short", // the short blue plank tumbles
    mosaic: 2,
  },
  {
    id: "solo-orange",
    name: "Slab",
    bg: "#0c0a08",
    keyColor: "#fff0dc",
    keyIntensity: 1.9,
    contact: { color: "#000000", opacity: 0.4 },
    bloom: true,
    solo: "orange", // the orange slab flips end-over-end
    mosaic: 3,
  },
  {
    id: "five",
    name: "The Five",
    bg: "#0b0d12",
    keyColor: "#fff1dc", // one soft, warm key – calm and minimal
    keyIntensity: 2.2,
    contact: { color: "#000000", opacity: 0.5 },
    bloom: true, // the figure glows as it completes
    five: true,
  },
]

// Pull the visual theme of a base "look" so extra levels can reuse it.
const VISUAL = (look: EnvKind) => {
  const b = BASE_ENVIRONMENTS.find((e) => e.id === look) ?? BASE_ENVIRONMENTS[0]
  return { look, bg: b.bg, keyColor: b.keyColor, keyIntensity: b.keyIntensity, contact: b.contact, bloom: b.bloom }
}
type KeyFlag = "stack" | "gather" | "corners" | "lineup" | "plate" | "apart"
// Extra levels that fill the board toward 25: each pairs a distinct room look
// with a key it doesn't already use, so every square is a fresh, solvable combo.
const EXTRA_SPECS: { name: string; look: EnvKind; key: KeyFlag }[] = [
  { name: "Glass · stack", look: "glass", key: "stack" },
  { name: "Gold · corners", look: "gold", key: "corners" },
  { name: "Play mat · gather", look: "playmat", key: "gather" },
  { name: "Concrete · line", look: "concrete", key: "lineup" },
  { name: "Video · scatter", look: "video", key: "apart" },
  { name: "Peel · stack", look: "peel", key: "stack" },
  { name: "Texture · gather", look: "texturemiss", key: "gather" },
  { name: "Fourth · scatter", look: "fourthside", key: "apart" },
]
const EXTRA_ENVIRONMENTS: EnvConfig[] = EXTRA_SPECS.map((s, i) => ({
  id: `x${i + 13}`,
  name: s.name,
  ...VISUAL(s.look),
  [s.key]: true,
}))

const ENVIRONMENTS: EnvConfig[] = [...BASE_ENVIRONMENTS, ...EXTRA_ENVIRONMENTS]

// Public level list (id + name, in play order) for the title/level-select UI.
export const LEVELS: { id: string; name: string }[] = ENVIRONMENTS.map((e) => ({ id: e.id, name: e.name }))

// Pastel foam play-mat: a grid of interlocking-feel pastel tiles with dark
// seam grooves and a little surface wear. Tiled across the floor + walls.
const PASTELS = ["#bcd9a6", "#e7b6c0", "#ecd791", "#bdaedb", "#aac7df", "#e6ad9d"]
function makePlayMatTexture(size = 512, cells = 4, seam = 0.04): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4)
  // a fixed pseudo-random palette assignment per cell (no Math.random so it's stable)
  const colAt = (cx: number, cy: number) => {
    const h = (cx * 7 + cy * 13 + cx * cy * 3) % PASTELS.length
    const hex = PASTELS[(h + PASTELS.length) % PASTELS.length]
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * cells
      const v = (y / size) * cells
      const cx = Math.floor(u)
      const cy = Math.floor(v)
      const fu = u - cx
      const fv = v - cy
      const edge = Math.min(fu, 1 - fu, fv, 1 - fv)
      let [r, g, b] = colAt(cx, cy)
      // darker groove in the seam between tiles
      if (edge < seam) {
        const k = 0.55 + 0.45 * (edge / seam)
        r *= k
        g *= k
        b *= k
      }
      // faint mottled wear
      const n = 0.93 + 0.07 * (((x * 131 + y * 57) % 17) / 17)
      const i = (y * size + x) * 4
      data[i] = Math.min(255, r * n)
      data[i + 1] = Math.min(255, g * n)
      data[i + 2] = Math.min(255, b * n)
      data[i + 3] = 255
    }
  }
  const tex = new THREE.DataTexture(data, size, size)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  tex.needsUpdate = true
  return tex
}

/* ------------------------------------------------------------------ */
/*  Haptics – "so you almost feel it". Vibration on every tactile beat: */
/*  grabbing, impacts (scaled by force), and squeezing.                 */
/* ------------------------------------------------------------------ */
function haptic(ms: number) {
  try {
    const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { vibrate?: (p: number | number[]) => boolean }) : null
    nav?.vibrate?.(Math.round(ms))
  } catch {}
}
let lastImpactBuzz = 0
function impactHaptic(strength: number) {
  const now = typeof performance !== "undefined" ? performance.now() : 0
  if (now - lastImpactBuzz < 38) return // don't machine-gun the motor during tumbles
  lastImpactBuzz = now
  haptic(4 + strength * 44)
}

// A short-lived flash of light a block leaves where it strikes a reactive floor.
type Glow = { x: number; z: number; strength: number; life: number; dur: number }
const GLOW_POOL = 18

function ImpactGlows({
  poolRef,
  active,
  tile,
}: {
  poolRef: React.MutableRefObject<Glow[]>
  active: boolean
  tile: number
}) {
  const refs = useRef<(THREE.Mesh | null)[]>([])
  useFrame((_s, dt) => {
    const pool = poolRef.current
    for (let i = 0; i < GLOW_POOL; i++) {
      const m = refs.current[i]
      if (!m) continue
      const g = pool[i]
      if (!active || !g || g.life <= 0) {
        if (m.visible) m.visible = false
        continue
      }
      g.life -= dt / g.dur
      if (g.life <= 0) {
        m.visible = false
        continue
      }
      m.visible = true
      // snap to the tile grid so a whole tile lights up
      m.position.set(Math.round(g.x / tile) * tile, 0.02, Math.round(g.z / tile) * tile)
      const s = tile * 0.96
      m.scale.set(s, s, s)
      const mat = m.material as THREE.MeshBasicMaterial
      // dim: the tiles are mainly an instrument now, the glow is just a soft cue
      mat.opacity = Math.min(0.5, 0.12 + g.strength * 0.45) * g.life * g.life
    }
  })
  return (
    <>
      {Array.from({ length: GLOW_POOL }).map((_, i) => (
        <mesh
          key={i}
          ref={(el) => {
            refs.current[i] = el
          }}
          rotation={[-Math.PI / 2, 0, 0]}
          visible={false}
        >
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial
            color="#dcefff"
            transparent
            opacity={0}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      ))}
    </>
  )
}

function TiltController({
  tiltRef,
  zeroG = false,
}: {
  tiltRef: React.MutableRefObject<TiltState>
  zeroG?: boolean
}) {
  const { world } = useRapier()
  const cur = useRef({ beta: 0, gamma: 0 })
  // Self-calibrated "down the screen" direction in the device's native in-plane
  // basis (right, down). Device/OS orientation reporting is unreliable across
  // phones and iPads, so instead of trusting screen.orientation.angle we learn
  // which way is down from where gravity actually pulls when tilt is engaged.
  const down = useRef<{ x: number; y: number } | null>(null)

  useFrame(() => {
    // zero-gravity environments (the magnet/totem room) float freely
    if (zeroG) {
      if (world) {
        world.gravity.x = 0
        world.gravity.y = 0
        world.gravity.z = 0
      }
      return
    }
    const t = tiltRef.current
    if (!t.enabled) down.current = null

    // smooth toward the target so motion feels like weight settling, not jitter
    cur.current.beta += ((t.enabled ? t.beta : 0) - cur.current.beta) * 0.12
    cur.current.gamma += ((t.enabled ? t.gamma : 0) - cur.current.gamma) * 0.12

    const b = THREE.MathUtils.clamp(cur.current.beta, -70, 70) * (Math.PI / 180)
    const g = THREE.MathUtils.clamp(cur.current.gamma, -70, 70) * (Math.PI / 180)

    // In-plane component of real gravity, in the device-native (right, down) basis.
    const inRight = Math.sin(g)
    const inDown = Math.sin(b)
    const mag = Math.hypot(inRight, inDown)

    // Lock in "down" the first time the device is meaningfully tilted after
    // enabling: whatever way gravity pulls on screen right now becomes down.
    if (t.enabled && !down.current && mag > 0.18) {
      down.current = { x: inRight / mag, y: inDown / mag }
    }

    let sRight = 0
    let sDown = 0
    if (down.current) {
      const { x: dx, y: dy } = down.current
      sDown = inRight * dx + inDown * dy // along calibrated down
      sRight = inRight * dy - inDown * dx // along screen-right (perp of down)
    }

    // publish the calibrated screen-space tilt so the UI icon can lean the same
    // way gravity is actually pulling
    t.sx = sRight
    t.sz = sDown

    // keep a little pull into the tray so blocks never ride up over the walls
    const gy = -Math.max(Math.cos(b) * Math.cos(g), 0.18)
    const v = new THREE.Vector3(sRight, gy, sDown).normalize().multiplyScalar(G)

    if (world) {
      world.gravity.x = v.x
      world.gravity.y = v.y
      world.gravity.z = v.z
    }
    // light positioning is owned by SceneContents (it blends the shift-drag
    // base position with this tilt offset), so nothing to do here.
  })

  return null
}

/* ------------------------------------------------------------------ */
/*  Scene contents (inside Canvas) – owns drag controller + walls      */
/* ------------------------------------------------------------------ */
type DragState = {
  body: RapierRigidBody
  block: Block
  plane: THREE.Plane // horizontal plane at the lift height
  localAnchor: THREE.Vector3 // grab point relative to the body centre, in body-local space
  liftY: number // current carry height (ramps up the longer you hold)
  baseLift: number // height at the moment of grab
  grabTime: number // performance.now() when grabbed – drives the "lift close" ramp
  radius: number // horizontal footprint, used to keep the block off the walls
}

const MIN_LIFT = 2.1 // grabbed blocks float well clear of the floor so you can carry them OVER a stacked layer
const MAX_LIFT = WALL_VIS_HEIGHT - 0.3 // never lift above the tray rim
const THROW_MAX = 5.0 // clamp on release speed – allows a light toss, not a hurl
const ESCAPE_MARGIN = 0.4 // how far past a wall a body must be before we rescue it

/* Soft "grab spring": the block is held by the exact point you grabbed, via a
   damped spring (PD controller) applied at that point. Because the pull acts at
   the grab point toward the cursor with a FIRST-ORDER velocity servo (it sets
   the body's velocity straight toward the target rather than accumulating
   spring impulses), so it can never overshoot or oscillate -> no shake. Spin is
   damped hard each frame so a carried piece stays steady, and the RELEASE speed
   is clamped low so a flick can never become a fling. */
const GRAB_RATE = 9 // grab-point error -> desired carry velocity (1/s)
const GRAB_RESPONSE = 0.35 // how fast the velocity eases to target each frame (no snap)
const MAX_DRAG_SPEED = 7 // carry speed cap – responsive but steady
const GRAB_ANG_DAMP = 0.78 // per-frame angular damping while held -> kills wobble/shake
const LIGHT_RADIUS = 14 // how far the key light orbits when you shift+right-drag it

/* ------------------------------------------------------------------ */
/*  Room environments – floor + walls + fill lighting, swapped by env   */
/* ------------------------------------------------------------------ */

type RoomProps = {
  env: EnvConfig
  box: Box
  visibleWalls: Wall[]
  shadowSpan: number
  roughMap: THREE.Texture
  muted: boolean // global mute state (drives the video room's audio)
}

// glass floor is tiled into chunky ~1.9-unit bricks; the glow snaps to this grid
const GLASS_FLOOR_REPEAT = 64
const GLASS_TILE = FLOOR / GLASS_FLOOR_REPEAT
// the reactive tiles are a musical instrument: C-major-pentatonic across the
// grid (column = note, row = octave) so the floor always sounds consonant
const PENTA = [0, 2, 4, 7, 9]
function tileFreq(x: number, z: number) {
  const col = Math.round(x / GLASS_TILE)
  const row = Math.round(z / GLASS_TILE)
  const semis = PENTA[((col % 5) + 5) % 5] + 12 * (((row % 3) + 3) % 3)
  return 261.63 * Math.pow(2, semis / 12) // relative to C4
}

/* ---- Morse: blink "KLOSSETE" on the winning blocks ---- */
const MORSE: Record<string, string> = { K: "-.-", L: ".-..", O: "---", S: "...", E: ".", T: "-" }
type Pulse = { on: boolean; units: number }
function morsePulses(text: string): Pulse[] {
  const out: Pulse[] = []
  const letters = text.toUpperCase().split("")
  letters.forEach((ch, li) => {
    const code = MORSE[ch]
    if (!code) return
    code.split("").forEach((sym, si) => {
      out.push({ on: true, units: sym === "-" ? 3 : 1 })
      if (si < code.length - 1) out.push({ on: false, units: 1 }) // intra-letter gap
    })
    out.push({ on: false, units: li < letters.length - 1 ? 3 : 7 }) // letter / word gap
  })
  return out
}
const KLOSSE_PULSES = morsePulses("KLOSSETE")
const KLOSSE_TOTAL = KLOSSE_PULSES.reduce((s, p) => s + p.units, 0)
const MORSE_UNIT = 0.16 // seconds per Morse unit

/* ---- klossete sorting puzzle: a home zone per block ---- */
type Zone = {
  id: string
  color: string
  shape: "box" | "cylinder"
  x: number
  z: number
  hx: number
  hz: number
  radius: number
  restY: number
  tolX: number
  tolZ: number
}
function puzzleZones(box: Box): Zone[] {
  const layout: { id: string; nx: number; nz: number }[] = [
    { id: "cube", nx: -0.5, nz: -0.55 },
    { id: "orange", nx: 0.5, nz: -0.55 },
    { id: "plank-long", nx: 0, nz: 0 },
    { id: "plank-short", nx: -0.5, nz: 0.6 },
    { id: "cylinder", nx: 0.5, nz: 0.6 },
  ]
  return layout.flatMap((L) => {
    const b = BLOCKS.find((bb) => bb.id === L.id)
    if (!b) return []
    const isCyl = b.shape === "cylinder"
    const hx = isCyl ? b.radius : b.half[0]
    const hz = isCyl ? b.radius : b.half[2]
    const restY = isCyl ? b.halfHeight : b.half[1]
    return [
      {
        id: L.id,
        color: b.color,
        shape: b.shape,
        x: L.nx * box.bx,
        z: L.nz * box.bz,
        hx,
        hz,
        radius: isCyl ? b.radius : 0,
        restY,
        tolX: hx + 0.7,
        tolZ: hz + 0.7,
      } satisfies Zone,
    ]
  })
}

function Room(props: RoomProps) {
  if (props.env.solo) return <SoloRoom {...props} />
  const look = props.env.look ?? props.env.id // extra levels reuse a base look
  if (look === "gold") return <GoldRoom {...props} />
  if (look === "glass") return <GlassRoom {...props} />
  if (look === "playmat") return <PlayMatRoom {...props} />
  if (look === "video") return <VideoRoom {...props} />
  if (look === "peel") return <PeelRoom {...props} />
  if (look === "texturemiss") return <TextureMissRoom {...props} />
  if (look === "fourthside") return <FourthRoom {...props} />
  if (look === "klossete") return <KlosseRoom {...props} />
  if (look === "projection") return <ProjectionRoom {...props} />
  if (look === "magnet") return <MagnetRoom />
  if (look === "maze") return <MazeRoom />
  if (look === "five") return <FiveRoom />
  return <ConcreteRoom {...props} />
}

// 9 — klossete sorting puzzle: dark mat with a coloured home zone per block.
function KlosseRoom({ box, visibleWalls }: RoomProps) {
  const zones = useMemo(() => puzzleZones(box), [box.bx, box.bz])
  return (
    <>
      <ambientLight intensity={0.5} color="#eef1f7" />
      <directionalLight position={[4, 10, -4]} intensity={0.5} color="#ffffff" />
      <pointLight position={[0, 9, 4]} intensity={14} distance={30} decay={2} color="#cfe0ff" />

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[box.bx * 2, box.bz * 2]} />
        <meshStandardMaterial color="#15171d" roughness={0.92} metalness={0} />
      </mesh>

      {zones.map((z) => (
        <group key={z.id} position={[z.x, 0.012, z.z]} rotation={[-Math.PI / 2, 0, 0]}>
          {z.shape === "cylinder" ? (
            <>
              <mesh>
                <circleGeometry args={[z.radius + 0.28, 40]} />
                <meshBasicMaterial color={z.color} transparent opacity={0.38} />
              </mesh>
              <lineSegments>
                <edgesGeometry args={[new THREE.CircleGeometry(z.radius + 0.28, 40)]} />
                <lineBasicMaterial color={z.color} transparent opacity={0.9} toneMapped={false} />
              </lineSegments>
            </>
          ) : (
            <>
              <mesh>
                <planeGeometry args={[(z.hx + 0.28) * 2, (z.hz + 0.28) * 2]} />
                <meshBasicMaterial color={z.color} transparent opacity={0.38} />
              </mesh>
              <lineSegments>
                <edgesGeometry args={[new THREE.PlaneGeometry((z.hx + 0.28) * 2, (z.hz + 0.28) * 2)]} />
                <lineBasicMaterial color={z.color} transparent opacity={0.9} toneMapped={false} />
              </lineSegments>
            </>
          )}
        </group>
      ))}

      {visibleWalls.map((w, i) => (
        <mesh key={`wall-${i}`} position={w.pos} castShadow receiveShadow>
          <boxGeometry args={[w.half[0] * 2, w.half[1] * 2, w.half[2] * 2]} />
          <meshStandardMaterial color="#1b1e25" roughness={0.9} metalness={0} />
        </mesh>
      ))}
    </>
  )
}

// Win detection + the Morse "lightbulb" celebration. Lives where it can see the
// rigid bodies; renders a flashing light + halo per block.
function PuzzleController({
  bodies,
  box,
  lockRef,
}: {
  bodies: React.MutableRefObject<Record<string, RapierRigidBody | null>>
  box: Box
  lockRef: React.MutableRefObject<boolean>
}) {
  const zones = useMemo(() => puzzleZones(box), [box.bx, box.bz])
  const win = useRef({ won: false, t: 0, brightness: 0 })
  const dwell = useRef(0)
  const prevOn = useRef(false)
  const groups = useRef<(THREE.Group | null)[]>([])

  useEffect(() => {
    // leaving the puzzle: unlock + hand the blocks back to physics
    return () => {
      lockRef.current = false
      for (const z of zones) bodies.current[z.id]?.setBodyType(BODY_DYNAMIC, true)
    }
  }, [zones, bodies, lockRef])

  useFrame((_s, dt) => {
    const W = win.current

    if (!W.won) {
      let all = true
      for (const z of zones) {
        const body = bodies.current[z.id]
        if (!body) {
          all = false
          break
        }
        const t = body.translation()
        const lv = body.linvel()
        const onZone =
          Math.abs(t.x - z.x) < z.tolX &&
          Math.abs(t.z - z.z) < z.tolZ &&
          t.y < z.restY + 0.6 // resting, not lifted
        const settled = Math.hypot(lv.x, lv.y, lv.z) < 0.7
        // the cylinder only counts if it's standing TALL on its circle
        let upright = true
        if (z.shape === "cylinder") {
          const r = body.rotation()
          const up = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w))
          upright = up.y > 0.82
        }
        if (!(onZone && settled && upright)) {
          all = false
          break
        }
      }
      if (all) {
        dwell.current += dt
        if (dwell.current > 0.45) {
          W.won = true
          W.t = 0
          lockRef.current = true
          for (const z of zones) bodies.current[z.id]?.setBodyType(BODY_KINEMATIC_POSITION, true)
        }
      } else {
        dwell.current = 0
      }
    } else {
      // Morse blink
      W.t += dt
      const tu = (W.t / MORSE_UNIT) % KLOSSE_TOTAL
      let acc = 0
      let on = false
      for (const p of KLOSSE_PULSES) {
        if (tu >= acc && tu < acc + p.units) {
          on = p.on
          break
        }
        acc += p.units
      }
      if (on && !prevOn.current) playBeep() // telegraph beep on each Morse pulse
      prevOn.current = on
      W.brightness += ((on ? 1 : 0) - W.brightness) * 0.55
      // shake the blocks while lit, hold them on their zones
      zones.forEach((z) => {
        const body = bodies.current[z.id]
        if (!body) return
        const sh = W.brightness * 0.05
        body.setNextKinematicTranslation({
          x: z.x + (Math.random() - 0.5) * sh,
          y: z.restY + 0.02 + Math.abs(Math.random()) * sh * 0.5,
          z: z.z + (Math.random() - 0.5) * sh,
        })
      })
    }

    // drive the lightbulbs
    groups.current.forEach((g) => {
      if (!g) return
      const light = g.children[0] as THREE.PointLight
      const halo = g.children[1] as THREE.Mesh
      if (light) light.intensity = W.brightness * 95
      if (halo) (halo.material as THREE.MeshBasicMaterial).opacity = W.brightness * 0.5
    })
  })

  return (
    <>
      {zones.map((z, i) => (
        <group
          key={z.id}
          position={[z.x, z.restY, z.z]}
          ref={(el) => {
            groups.current[i] = el
          }}
        >
          <pointLight intensity={0} distance={14} decay={2} color="#fffbe8" />
          <mesh scale={Math.max(z.hx, z.hz, z.radius) * 2.4}>
            <sphereGeometry args={[1, 16, 16]} />
            <meshBasicMaterial color="#fffdf2" transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
          </mesh>
        </group>
      ))}
    </>
  )
}

/* ---- projection puzzle: flat colour projections + a target shape ---- */
function projectionTargets(box: Box): Zone[] {
  // A balanced, symmetric emblem: the big square sits in the centre, the small
  // square above and the circle below, with the two planks as side bars. Fixed
  // world spacing (scaled down only if the tray is small) so it always reads as
  // a deliberate composition rather than stretching with the aspect ratio.
  const layout: { id: string; x: number; z: number }[] = [
    { id: "orange", x: 0, z: 0 }, // central square
    { id: "cube", x: 0, z: -2.05 }, // small square above
    { id: "cylinder", x: 0, z: 2.05 }, // circle below
    { id: "plank-long", x: -2.0, z: 0 }, // left bar
    { id: "plank-short", x: 2.0, z: 0 }, // right bar
  ]
  const fit = Math.min(1, (box.bx - 0.5) / 2.6, (box.bz - 0.5) / 2.7)
  return layout.flatMap((L) => {
    const b = BLOCKS.find((bb) => bb.id === L.id)
    if (!b) return []
    const isCyl = b.shape === "cylinder"
    const hx = isCyl ? b.radius : b.half[0]
    const hz = isCyl ? b.radius : b.half[2]
    const restY = isCyl ? b.halfHeight : b.half[1]
    return [
      {
        id: L.id,
        color: b.color,
        shape: b.shape,
        x: L.x * fit,
        z: L.z * fit,
        hx,
        hz,
        radius: isCyl ? b.radius : 0,
        restY,
        tolX: hx + 0.6,
        tolZ: hz + 0.6,
      } satisfies Zone,
    ]
  })
}

// 10 — Projection room: the 3D shapes are flat and colourless; you only see
// their colour as a flat projection on the dark floor. Slide the projections
// onto the target outline (a symmetric emblem) and the 3D forms appear.
function ProjectionRoom({ box, visibleWalls }: RoomProps) {
  const targets = useMemo(() => projectionTargets(box), [box.bx, box.bz])
  return (
    <>
      <ambientLight intensity={0.34} color="#aab2c4" />
      <directionalLight position={[-6, 18, -5]} intensity={0.7} color="#ffffff" />

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[box.bx * 2, box.bz * 2]} />
        <meshStandardMaterial color="#101218" roughness={0.96} metalness={0} />
      </mesh>

      {/* the target slots the projections must be arranged onto: a faint filled
          recess + a crisp outline so each reads as a place to drop a piece */}
      {targets.map((z) => (
        <group key={z.id} position={[z.x, 0.014, z.z]} rotation={[-Math.PI / 2, 0, 0]}>
          <mesh>
            {z.shape === "cylinder" ? (
              <circleGeometry args={[z.radius + 0.1, 44]} />
            ) : (
              <planeGeometry args={[(z.hx + 0.1) * 2, (z.hz + 0.1) * 2]} />
            )}
            <meshBasicMaterial color="#8294b4" transparent opacity={0.08} toneMapped={false} />
          </mesh>
          <lineSegments>
            <edgesGeometry
              args={[
                z.shape === "cylinder"
                  ? new THREE.CircleGeometry(z.radius + 0.1, 44)
                  : new THREE.PlaneGeometry((z.hx + 0.1) * 2, (z.hz + 0.1) * 2),
              ]}
            />
            <lineBasicMaterial color="#9fb0cf" transparent opacity={0.9} toneMapped={false} />
          </lineSegments>
        </group>
      ))}

      {visibleWalls.map((w, i) => (
        <mesh key={`wall-${i}`} position={w.pos} castShadow receiveShadow>
          <boxGeometry args={[w.half[0] * 2, w.half[1] * 2, w.half[2] * 2]} />
          <meshStandardMaterial color="#15171d" roughness={0.92} metalness={0} />
        </mesh>
      ))}
    </>
  )
}

// Live colour projections under each block + solve detection + the reveal flash.
function ProjectionController({
  bodies,
  box,
  revealRef,
}: {
  bodies: React.MutableRefObject<Record<string, RapierRigidBody | null>>
  box: Box
  revealRef: React.MutableRefObject<boolean>
}) {
  const targets = useMemo(() => projectionTargets(box), [box.bx, box.bz])
  const groups = useRef<(THREE.Group | null)[]>([])
  const dwell = useRef(0)
  const flash = useRef<THREE.PointLight>(null)
  const flashT = useRef(0)

  useEffect(() => () => {
    revealRef.current = false
  }, [revealRef])

  useFrame((_s, dt) => {
    // slide each colour projection to sit directly under its (colourless) block
    targets.forEach((z, i) => {
      const g = groups.current[i]
      const body = bodies.current[z.id]
      if (!g || !body) return
      const t = body.translation()
      const r = body.rotation()
      const yaw = Math.atan2(2 * (r.w * r.y + r.x * r.z), 1 - 2 * (r.y * r.y + r.z * r.z))
      g.position.set(t.x, 0.02, t.z)
      g.rotation.set(-Math.PI / 2, 0, -yaw)
    })

    if (!revealRef.current) {
      let all = true
      for (const z of targets) {
        const body = bodies.current[z.id]
        if (!body) {
          all = false
          break
        }
        const t = body.translation()
        const lv = body.linvel()
        const placed =
          Math.abs(t.x - z.x) < z.tolX &&
          Math.abs(t.z - z.z) < z.tolZ &&
          Math.hypot(lv.x, lv.y, lv.z) < 1.3
        if (!placed) {
          all = false
          break
        }
      }
      if (all) {
        dwell.current += dt
        if (dwell.current > 0.5) {
          revealRef.current = true
          flashT.current = 1
        }
      } else {
        dwell.current = 0
      }
    }

    flashT.current = Math.max(0, flashT.current - dt * 0.8)
    if (flash.current) flash.current.intensity = flashT.current * 70
  })

  return (
    <>
      <pointLight ref={flash} position={[0, 6, 0]} distance={44} decay={2} color="#ffffff" intensity={0} />
      {targets.map((z, i) => (
        <group
          key={z.id}
          ref={(el) => {
            groups.current[i] = el
          }}
          rotation={[-Math.PI / 2, 0, 0]}
        >
          <mesh>
            {z.shape === "cylinder" ? (
              <circleGeometry args={[z.radius, 40]} />
            ) : (
              <planeGeometry args={[z.hx * 2, z.hz * 2]} />
            )}
            <meshBasicMaterial color={z.color} transparent opacity={0.92} toneMapped={false} />
          </mesh>
        </group>
      ))}
    </>
  )
}

/* ---- magnet totem: each piece snaps to ONE partner, building a figure ---- */
// A small graph: every piece (except the root body) has exactly one partner it
// snaps to, with a relative pose. Snapped together they read as a little figure:
// head over body, an arm to the side, legs under the body, a base under the legs.
type Link = {
  id: string
  parent: string
  off: [number, number, number] // target offset from the parent (parent-local)
  rot: [number, number, number] // target orientation relative to the parent (euler)
}
const TOTEM_LINKS: Link[] = [
  { id: "cube", parent: "orange", off: [0, 0, -1.7], rot: [0, 0, 0] }, // head, above
  { id: "cylinder", parent: "orange", off: [1.75, 0, 0.05], rot: [0, 0, Math.PI / 2] }, // arm, right (lying)
  { id: "plank-short", parent: "orange", off: [0, 0, 2.2], rot: [0, 0, 0] }, // legs, below (upright)
  { id: "plank-long", parent: "plank-short", off: [0, 0, 2.0], rot: [0, Math.PI / 2, 0] }, // base, bottom (across)
]
const SNAP_RADIUS = 2.0 // a piece starts feeling its partner within this distance
const CONNECT_DIST = 0.55 // considered "snapped" (counts toward the solve) within this
const MAG_PULL = 6 // proximity error -> gentle velocity toward the snap pose
const MAG_RESPONSE = 0.16 // how fast that velocity is applied (low = soft, not forcible)

function MagnetController({
  bodies,
  box,
  dragRef,
  revealRef,
}: {
  bodies: React.MutableRefObject<Record<string, RapierRigidBody | null>>
  box: Box
  dragRef: React.MutableRefObject<DragState | null>
  revealRef: React.MutableRefObject<boolean>
}) {
  // glowing dashed tether per link, built imperatively (avoids the JSX <line>
  // clashing with the SVG line element)
  const lines = useMemo(
    () =>
      TOTEM_LINKS.map(() => {
        const geom = new THREE.BufferGeometry()
        geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3))
        const mat = new THREE.LineDashedMaterial({
          color: "#7fb4ff",
          transparent: true,
          opacity: 0.6,
          dashSize: 0.12,
          gapSize: 0.12,
          toneMapped: false,
        })
        const line = new THREE.Line(geom, mat)
        line.visible = false
        line.frustumCulled = false
        return line
      }),
    [],
  )
  const flash = useRef<THREE.PointLight>(null)
  const flashT = useRef(0)
  const dwell = useRef(0)
  const scattered = useRef(false)

  useEffect(() => () => {
    revealRef.current = false
  }, [revealRef])

  useFrame((_s, dt) => {
    const dragged = dragRef.current?.body ?? null
    let connectedCount = 0

    // on first frame in the space level, scatter the pieces across space at
    // random floating orientations (no floor/gravity -> they hang at odd angles)
    if (!scattered.current) {
      scattered.current = true
      for (const b of BLOCKS) {
        const body = bodies.current[b.id]
        if (!body) {
          scattered.current = false // bodies not ready yet – try next frame
          break
        }
      }
      if (scattered.current) {
        for (const b of BLOCKS) {
          const body = bodies.current[b.id]
          if (!body) continue
          const r = blockRadius(b)
          const x = (Math.random() * 2 - 1) * Math.max(box.bx - r - 0.6, 0.5)
          const z = (Math.random() * 2 - 1) * Math.max(box.bz - r - 0.6, 0.5)
          body.setTranslation({ x, y: 1.2 + Math.random() * 2.4, z }, true)
          const e = new THREE.Euler(
            Math.random() * Math.PI * 2,
            Math.random() * Math.PI * 2,
            Math.random() * Math.PI * 2,
          )
          const q = new THREE.Quaternion().setFromEuler(e)
          body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true)
          body.setLinvel({ x: 0, y: 0, z: 0 }, true)
          body.setAngvel(
            { x: (Math.random() - 0.5) * 0.5, y: (Math.random() - 0.5) * 0.5, z: (Math.random() - 0.5) * 0.5 },
            true,
          )
        }
      }
    }

    TOTEM_LINKS.forEach((link, i) => {
      const child = bodies.current[link.id]
      const parent = bodies.current[link.parent]
      const line = lines[i]
      if (!child || !parent) {
        if (line) line.visible = false
        return
      }
      const pp = parent.translation()
      const pr = parent.rotation()
      const pq = new THREE.Quaternion(pr.x, pr.y, pr.z, pr.w)
      const offW = new THREE.Vector3(link.off[0], link.off[1], link.off[2]).applyQuaternion(pq)
      const targetPos = new THREE.Vector3(pp.x + offW.x, pp.y + offW.y, pp.z + offW.z)
      const cp = child.translation()
      const toTarget = targetPos.clone().sub(new THREE.Vector3(cp.x, cp.y, cp.z))
      const dist = toTarget.length()
      const connected = dist < CONNECT_DIST
      if (connected) connectedCount++

      // gentle magnetic pull on the child toward the snap pose (skip while it's
      // the piece being dragged, so the cursor stays in full control)
      if (dist < SNAP_RADIUS && child !== dragged) {
        const k = 1 - dist / SNAP_RADIUS // firmer the closer it gets
        const dvx = toTarget.x * MAG_PULL
        const dvy = toTarget.y * MAG_PULL
        const dvz = toTarget.z * MAG_PULL
        const lv = child.linvel()
        const a = MAG_RESPONSE * (0.35 + 0.65 * k)
        child.setLinvel(
          { x: lv.x + (dvx - lv.x) * a, y: lv.y + (dvy - lv.y) * a, z: lv.z + (dvz - lv.z) * a },
          true,
        )
        // ease orientation toward the target pose
        const targetQ = pq.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(...link.rot)))
        const cr = child.rotation()
        const cq = new THREE.Quaternion(cr.x, cr.y, cr.z, cr.w)
        cq.slerp(targetQ, 0.1 + 0.18 * k)
        child.setRotation({ x: cq.x, y: cq.y, z: cq.z, w: cq.w }, true)
        child.setAngvel({ x: 0, y: 0, z: 0 }, true)
      }

      // tether: a glowing dashed line drawn once the two are within reach
      if (line) {
        const show = dist < SNAP_RADIUS
        line.visible = show
        if (show) {
          const pos = line.geometry.attributes.position as THREE.BufferAttribute
          pos.setXYZ(0, cp.x, cp.y, cp.z) // the piece
          pos.setXYZ(1, pp.x, pp.y, pp.z) // its one partner
          pos.needsUpdate = true
          line.computeLineDistances()
          const mat = line.material as THREE.LineDashedMaterial
          mat.opacity = connected ? 0.95 : 0.35 + 0.5 * (1 - dist / SNAP_RADIUS)
        }
      }
    })

    // edge force-field: in zero-g there's no floor/walls, so gently ease every
    // piece's velocity back inward as it drifts toward the screen bounds. It
    // ramps in over a soft margin and *eases* the velocity (no hard stop) so it
    // feels like a soft field, not a collision.
    const { bx, bz } = box
    const MARGIN = 1.2 // start nudging this far before the edge
    const REP = 3.0 // inward speed at deep penetration
    const EASE = 0.12 // how gently the velocity is steered inward
    const ease = (pos: number, vel: number, lim: number): number => {
      const inset = Math.max(lim - MARGIN, 0.4)
      let target = vel
      if (pos > inset) target = -(pos - inset) * REP
      else if (pos < -inset) target = (-inset - pos) * REP
      else return vel
      return vel + (target - vel) * EASE
    }
    for (const b of BLOCKS) {
      const body = bodies.current[b.id]
      if (!body || body === dragged) continue
      const t = body.translation()
      const lv = body.linvel()
      const r = blockRadius(b)
      const nx = ease(t.x, lv.x, Math.max(bx - r, 0.6))
      const nz = ease(t.z, lv.z, Math.max(bz - r, 0.6))
      const yMid = 2.4
      const yHalf = 2.6
      const ny = ease(t.y - yMid, lv.y, yHalf) // re-centre on the band
      body.setLinvel({ x: nx, y: ny, z: nz }, true)
    }

    if (!revealRef.current) {
      if (connectedCount === TOTEM_LINKS.length) {
        dwell.current += dt
        if (dwell.current > 0.5) {
          revealRef.current = true
          flashT.current = 1
        }
      } else {
        dwell.current = 0
      }
    }
    flashT.current = Math.max(0, flashT.current - dt * 0.8)
    if (flash.current) flash.current.intensity = flashT.current * 80
  })

  return (
    <>
      <pointLight ref={flash} position={[0, 4, 2]} distance={40} decay={2} color="#bcd4ff" intensity={0} />
      {lines.map((l, i) => (
        <primitive key={i} object={l} />
      ))}
    </>
  )
}

// — Magnet/totem room: dark open space with a sparse starfield, no floor.
function MagnetRoom() {
  const stars = useMemo(() => {
    const n = 220
    const a = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      a[i * 3] = (Math.random() - 0.5) * 80
      a[i * 3 + 1] = -2 - Math.random() * 30
      a[i * 3 + 2] = (Math.random() - 0.5) * 80
    }
    return a
  }, [])
  return (
    <>
      {/* hard sun: the shared key light does the lighting; here we keep only a
          whisper of cool fill so the shadow side isn't pure black, and add a
          bright bloom "sun" up in the corner for the glare */}
      <ambientLight intensity={0.05} color="#2a3a5c" />
      <pointLight position={[8, 4, 7]} intensity={3} distance={40} decay={2} color="#3b5a8a" />
      <mesh position={[-15, 17, -13]}>
        <sphereGeometry args={[2.2, 32, 32]} />
        <meshBasicMaterial color="#fff4dc" toneMapped={false} />
      </mesh>
      <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[stars, 3]} count={stars.length / 3} itemSize={3} />
        </bufferGeometry>
        <pointsMaterial color="#cdd8ff" size={0.07} sizeAttenuation transparent opacity={0.8} toneMapped={false} />
      </points>
    </>
  )
}

/* ---- maze: a single block you "flip-flop" tip through corridors ---- */
// This level strips you to one block. Press a direction (arrows/WASD or swipe)
// and it tips 90° over its leading edge to the next cell – "flip-flop walking".
// The camera follows it top-down, so you roam a maze far larger than the screen.
// Reach the glowing exit and the level is solved.
const MAZE_CELL = 30 * 0.036 // one cube edge = one grid cell (matches the cube)
type Maze = {
  W: number
  H: number
  wall: boolean[][]
  start: [number, number]
  goal: [number, number]
  spots: [number, number][] // cells where the four other blocks wait to be collected
}
// Recursive-backtracker maze on a (2·rooms+1) grid; the goal is the floor cell
// farthest from the centre start (BFS), so it's always reachable.
function buildMaze(rooms: number, seed: number): Maze {
  const W = rooms * 2 + 1
  const H = rooms * 2 + 1
  const wall: boolean[][] = Array.from({ length: H }, () => Array(W).fill(true))
  let s = (seed >>> 0) || 1
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
  const stack: [number, number][] = [[1, 1]]
  wall[1][1] = false
  const dirs = [
    [0, -2],
    [0, 2],
    [-2, 0],
    [2, 0],
  ] as const
  while (stack.length) {
    const [x, y] = stack[stack.length - 1]
    const opts = dirs
      .map(([dx, dy]) => [x + dx, y + dy, dx, dy] as const)
      .filter(([nx, ny]) => nx > 0 && ny > 0 && nx < W - 1 && ny < H - 1 && wall[ny][nx])
    if (!opts.length) {
      stack.pop()
      continue
    }
    const [nx, ny, dx, dy] = opts[Math.floor(rnd() * opts.length)]
    wall[y + dy / 2][x + dx / 2] = false
    wall[ny][nx] = false
    stack.push([nx, ny])
  }
  const c = Math.floor(rooms / 2) * 2 + 1
  const start: [number, number] = [c, c]
  // BFS from the start to the farthest reachable floor cell -> the exit
  const dist: number[][] = Array.from({ length: H }, () => Array(W).fill(-1))
  dist[start[1]][start[0]] = 0
  const queue: [number, number][] = [[start[0], start[1]]]
  let goal: [number, number] = start
  let best = 0
  const nb = [
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0],
  ] as const
  while (queue.length) {
    const [x, y] = queue.shift()!
    for (const [dx, dy] of nb) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || wall[ny][nx] || dist[ny][nx] >= 0) continue
      dist[ny][nx] = dist[y][x] + 1
      if (dist[ny][nx] > best) {
        best = dist[ny][nx]
        goal = [nx, ny]
      }
      queue.push([nx, ny])
    }
  }
  // four collectible cells: spread-out dead-ends (fall back to far floor cells),
  // so you stumble on the other blocks one at a time as you explore
  const spots: [number, number][] = []
  const spread = (cell: [number, number], min: number) =>
    spots.every((s) => Math.abs(s[0] - cell[0]) + Math.abs(s[1] - cell[1]) >= min)
  const deadends: { cell: [number, number]; d: number }[] = []
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (wall[y][x] || (x === start[0] && y === start[1])) continue
      let open = 0
      for (const [dx, dy] of nb) if (!wall[y + dy][x + dx]) open++
      if (open === 1) deadends.push({ cell: [x, y], d: dist[y][x] })
    }
  }
  deadends.sort((a, b) => b.d - a.d)
  for (const de of deadends) {
    if (spots.length >= 4) break
    if (spread(de.cell, 4)) spots.push(de.cell)
  }
  if (spots.length < 4) {
    const floors: { cell: [number, number]; d: number }[] = []
    for (let y = 1; y < H - 1; y++)
      for (let x = 1; x < W - 1; x++)
        if (!wall[y][x] && !(x === start[0] && y === start[1])) floors.push({ cell: [x, y], d: dist[y][x] })
    floors.sort((a, b) => b.d - a.d)
    for (const f of floors) {
      if (spots.length >= 4) break
      if (spread(f.cell, 3)) spots.push(f.cell)
    }
  }
  return { W, H, wall, start, goal, spots }
}
const MAZE = buildMaze(8, 20260617) // larger maze
// grid cell -> world (x,z), with the start cell at the origin
function mazeWorld(gx: number, gy: number): [number, number] {
  return [(gx - MAZE.start[0]) * MAZE_CELL, (gy - MAZE.start[1]) * MAZE_CELL]
}

// — Maze room: dark floor, a forest of wall blocks, a glowing exit tile.
function MazeRoom() {
  // All wall cubes drawn as ONE instanced mesh (one draw call, no shadows) so
  // even the large maze stays light on mobile GPUs.
  const wallMesh = useMemo(() => {
    const cells: [number, number][] = []
    for (let y = 0; y < MAZE.H; y++) for (let x = 0; x < MAZE.W; x++) if (MAZE.wall[y][x]) cells.push([x, y])
    const geo = new THREE.BoxGeometry(MAZE_CELL, MAZE_CELL, MAZE_CELL)
    const mat = new THREE.MeshStandardMaterial({ color: "#27345c", roughness: 0.78, metalness: 0.06 })
    const mesh = new THREE.InstancedMesh(geo, mat, cells.length)
    mesh.castShadow = false
    mesh.receiveShadow = false
    const o = new THREE.Object3D()
    cells.forEach(([x, y], i) => {
      const [wx, wz] = mazeWorld(x, y)
      o.position.set(wx, MAZE_CELL * 0.5, wz)
      o.updateMatrix()
      mesh.setMatrixAt(i, o.matrix)
    })
    mesh.instanceMatrix.needsUpdate = true
    return mesh
  }, [])
  useEffect(
    () => () => {
      wallMesh.geometry.dispose()
      ;(wallMesh.material as THREE.Material).dispose()
    },
    [wallMesh],
  )
  return (
    <>
      <ambientLight intensity={0.4} color="#22304c" />
      <pointLight position={[0, 14, 0]} intensity={26} distance={70} decay={2} color="#bcd0ff" />
      {/* a large dark floor under the whole maze */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        <planeGeometry args={[MAZE.W * MAZE_CELL + 6, MAZE.H * MAZE_CELL + 6]} />
        <meshStandardMaterial color="#0b1020" roughness={0.96} metalness={0} />
      </mesh>
      <primitive object={wallMesh} />
      {/* the exit: a lit tile + a tall beacon you can steer toward */}
      <MazeExit />
    </>
  )
}

function MazeExit() {
  const [gx, gz] = mazeWorld(MAZE.goal[0], MAZE.goal[1])
  return (
    <>
      <mesh position={[gx, 0.03, gz]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[MAZE_CELL * 0.92, MAZE_CELL * 0.92]} />
        <meshBasicMaterial color="#7cf6c8" toneMapped={false} transparent opacity={0.9} />
      </mesh>
      <mesh position={[gx, 9, gz]}>
        <cylinderGeometry args={[0.12, 0.12, 18, 8, 1, true]} />
        <meshBasicMaterial color="#7cf6c8" toneMapped={false} transparent opacity={0.32} side={THREE.DoubleSide} />
      </mesh>
      <pointLight position={[gx, 1.6, gz]} intensity={12} distance={9} decay={2} color="#7cf6c8" />
    </>
  )
}

type TipState = {
  t: number
  dur: number
  axis: THREE.Vector3
  pivot: THREE.Vector3
  startCenter: THREE.Vector3
  startQ: THREE.Quaternion
  target: [number, number]
}
function MazeController({
  bodies,
  revealRef,
}: {
  bodies: React.MutableRefObject<Record<string, RapierRigidBody | null>>
  revealRef: React.MutableRefObject<boolean>
}) {
  const camera = useThree((s) => s.camera)
  const cell = useRef<[number, number]>([MAZE.start[0], MAZE.start[1]])
  const tip = useRef<TipState | null>(null)
  const heldDir = useRef<[number, number] | null>(null) // tap-hold steering direction
  const camY = useRef<number | null>(null) // follow height (a touch higher = wider view)
  const origCamY = useRef(0) // the rig's height, restored when we leave
  const flash = useRef<THREE.PointLight>(null)
  const flashT = useRef(0)
  const glow = useRef<THREE.PointLight>(null) // a soft light riding the player
  const landT = useRef(0) // brief brighten as it lands
  const stepCool = useRef(0) // brief beat between rolls so it's an unhurried walk

  // seat the player cube at the start cell (the other blocks aren't even rendered
  // in this level – see BLOCKS render below – so there's nothing to hide)
  useEffect(() => {
    cell.current = [MAZE.start[0], MAZE.start[1]]
    tip.current = null
    heldDir.current = null
    const cube = bodies.current["cube"]
    if (cube) {
      cube.setBodyType(BODY_KINEMATIC_POSITION, true)
      cube.setNextKinematicTranslation({ x: 0, y: MAZE_CELL / 2, z: 0 })
      cube.setNextKinematicRotation({ x: 0, y: 0, z: 0, w: 1 })
    }
    return () => {
      const c = bodies.current["cube"]
      if (c) {
        c.setBodyType(BODY_DYNAMIC, true)
        c.setLinvel({ x: 0, y: 0, z: 0 }, true)
        c.setAngvel({ x: 0, y: 0, z: 0 }, true)
      }
      camera.position.x = 0
      camera.position.z = 0
      if (origCamY.current) camera.position.y = origCamY.current
      camera.lookAt(0, 0, 0)
      camY.current = null
      revealRef.current = false
    }
  }, [bodies, revealRef, camera])

  // input -> a HELD steering direction (grid +y is world +z). Tap-and-hold to
  // keep rolling that way; release to stop. No more one-tap-per-roll.
  useEffect(() => {
    const keys = new Set<string>()
    const map = (k: string) =>
      k === "arrowup" || k === "w"
        ? "up"
        : k === "arrowdown" || k === "s"
          ? "down"
          : k === "arrowleft" || k === "a"
            ? "left"
            : k === "arrowright" || k === "d"
              ? "right"
              : null
    const dirOf = (m: string | null): [number, number] | null =>
      m === "up" ? [0, -1] : m === "down" ? [0, 1] : m === "left" ? [-1, 0] : m === "right" ? [1, 0] : null
    const fromKeys = (): [number, number] | null => {
      for (const m of ["up", "down", "left", "right"]) if (keys.has(m)) return dirOf(m)
      return null
    }
    const onDown = (e: KeyboardEvent) => {
      const m = map(e.key.toLowerCase())
      if (!m) return
      keys.add(m)
      heldDir.current = dirOf(m) // newest press wins
      e.preventDefault()
    }
    const onUp = (e: KeyboardEvent) => {
      const m = map(e.key.toLowerCase())
      if (!m) return
      keys.delete(m)
      heldDir.current = fromKeys()
    }
    // touch: hold a finger and the cube rolls toward it (relative to screen centre)
    const dirFromTouch = (t: Touch): [number, number] | null => {
      const dx = t.clientX - window.innerWidth / 2
      const dy = t.clientY - window.innerHeight / 2
      if (Math.abs(dx) < 18 && Math.abs(dy) < 18) return heldDir.current
      return Math.abs(dx) > Math.abs(dy) ? [dx > 0 ? 1 : -1, 0] : [0, dy > 0 ? 1 : -1]
    }
    const tMove = (e: TouchEvent) => {
      const t = e.touches[0]
      if (t && e.touches.length === 1) heldDir.current = dirFromTouch(t)
    }
    const tEnd = (e: TouchEvent) => {
      if (e.touches.length === 0) heldDir.current = null
    }
    window.addEventListener("keydown", onDown)
    window.addEventListener("keyup", onUp)
    window.addEventListener("touchstart", tMove, { passive: true })
    window.addEventListener("touchmove", tMove, { passive: true })
    window.addEventListener("touchend", tEnd, { passive: true })
    window.addEventListener("touchcancel", tEnd, { passive: true })
    return () => {
      window.removeEventListener("keydown", onDown)
      window.removeEventListener("keyup", onUp)
      window.removeEventListener("touchstart", tMove)
      window.removeEventListener("touchmove", tMove)
      window.removeEventListener("touchend", tEnd)
      window.removeEventListener("touchcancel", tEnd)
    }
  }, [])

  useFrame((_s, dt) => {
    const cube = bodies.current["cube"]
    if (!cube) return
    if (camY.current == null) {
      origCamY.current = camera.position.y
      camY.current = camera.position.y * 1.5 // pull back so a good chunk of maze reads
    }
    const cy = camY.current ?? camera.position.y
    if (cube.bodyType() !== BODY_KINEMATIC_POSITION) cube.setBodyType(BODY_KINEMATIC_POSITION, true)
    stepCool.current = Math.max(0, stepCool.current - dt)

    // tap-and-hold: roll cell to cell while a direction is held, at a calm,
    // unhurried pace (a roll, a small beat, then the next)
    if (!tip.current && heldDir.current && stepCool.current === 0 && !revealRef.current) {
      const [dx, dy] = heldDir.current
      const [gx, gy] = cell.current
      const tx = gx + dx
      const ty = gy + dy
      const open = ty >= 0 && ty < MAZE.H && tx >= 0 && tx < MAZE.W && !MAZE.wall[ty][tx]
      if (open) {
        const [wx, wz] = mazeWorld(gx, gy)
        const d = new THREE.Vector3(dx, 0, dy)
        const up = new THREE.Vector3(0, 1, 0)
        const startCenter = new THREE.Vector3(wx, MAZE_CELL / 2, wz)
        tip.current = {
          t: 0,
          dur: 0.26, // slower, weightier roll
          axis: new THREE.Vector3().crossVectors(up, d).normalize(),
          pivot: startCenter
            .clone()
            .add(d.clone().multiplyScalar(MAZE_CELL / 2))
            .add(up.clone().multiplyScalar(-MAZE_CELL / 2)),
          startCenter,
          startQ: new THREE.Quaternion(),
          target: [tx, ty],
        }
        haptic(5)
      }
    }

    if (tip.current) {
      const T = tip.current
      T.t = Math.min(T.dur, T.t + dt)
      const k = T.t / T.dur
      const theta = (Math.PI / 2) * (k * k * (3 - 2 * k)) // ease off the edge, settle flat
      const q = new THREE.Quaternion().setFromAxisAngle(T.axis, theta)
      const c = T.pivot.clone().add(T.startCenter.clone().sub(T.pivot).applyQuaternion(q))
      const rot = q.clone().multiply(T.startQ)
      cube.setNextKinematicTranslation({ x: c.x, y: c.y, z: c.z })
      cube.setNextKinematicRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w })
      if (T.t >= T.dur) {
        cell.current = T.target
        const [fx, fz] = mazeWorld(T.target[0], T.target[1])
        cube.setNextKinematicTranslation({ x: fx, y: MAZE_CELL / 2, z: fz })
        cube.setNextKinematicRotation({ x: 0, y: 0, z: 0, w: 1 })
        tip.current = null
        stepCool.current = 0.09 // a small beat before the next roll
        playImpact("cube", 0.42) // a wooden knock as it lands
        haptic(8)
        landT.current = 1
        if (T.target[0] === MAZE.goal[0] && T.target[1] === MAZE.goal[1] && !revealRef.current) {
          revealRef.current = true // reached the exit -> solved, progression advances
          flashT.current = 1
        }
      }
    } else {
      // idle: pin the cube to its cell so nothing (e.g. a reset) drifts it
      const [wx, wz] = mazeWorld(cell.current[0], cell.current[1])
      cube.setNextKinematicTranslation({ x: wx, y: MAZE_CELL / 2, z: wz })
      cube.setNextKinematicRotation({ x: 0, y: 0, z: 0, w: 1 })
    }

    // follow the lone player cube, kept centred with a touch of smoothing
    const t = cube.translation()
    camera.position.x += (t.x - camera.position.x) * 0.4
    camera.position.z += (t.z - camera.position.z) * 0.4
    camera.position.y = cy
    camera.lookAt(camera.position.x, 0, camera.position.z)

    landT.current = Math.max(0, landT.current - dt * 2.4)
    if (glow.current) {
      glow.current.position.set(t.x, t.y + 0.6, t.z)
      glow.current.intensity = 7 + landT.current * 20
    }
    flashT.current = Math.max(0, flashT.current - dt * 0.6)
    if (flash.current) {
      const [gx, gz] = mazeWorld(MAZE.goal[0], MAZE.goal[1])
      flash.current.position.set(gx, 2, gz)
      flash.current.intensity = flashT.current * 120
    }
  })

  return (
    <>
      <pointLight ref={flash} distance={60} decay={2} color="#7cf6c8" intensity={0} />
      <pointLight ref={glow} distance={6} decay={2} color="#dcebff" intensity={7} />
    </>
  )
}

/* ---- gather puzzle: bring every block onto the glowing pad ---- */
// A simple, physical "key": drag all five blocks so they rest inside the lit
// circle. The ring brightens as more land on it; fill it and the room solves.
const GATHER_RADIUS = 1.9
function GatherController({
  bodies,
  box,
  revealRef,
}: {
  bodies: React.MutableRefObject<Record<string, RapierRigidBody | null>>
  box: Box
  revealRef: React.MutableRefObject<boolean>
}) {
  const ring = useRef<THREE.Mesh>(null)
  const flash = useRef<THREE.PointLight>(null)
  const dwell = useRef(0)
  const flashT = useRef(0)
  // keep the pad inside the tray on small screens
  const radius = Math.min(GATHER_RADIUS, Math.min(box.bx, box.bz) - 0.5)

  useEffect(() => () => {
    revealRef.current = false
  }, [revealRef])

  useFrame((_s, dt) => {
    let inCount = 0
    let allReady = true
    for (const b of BLOCKS) {
      const body = bodies.current[b.id]
      if (!body) {
        allReady = false
        continue
      }
      const t = body.translation()
      const lv = body.linvel()
      const horiz = Math.hypot(t.x, t.z)
      const speed = Math.hypot(lv.x, lv.y, lv.z)
      const onPad = horiz < radius && t.y < 1.4 && speed < 0.6 // resting on the floor, inside the ring
      if (onPad) inCount++
      else allReady = false
    }
    // the ring glows brighter the more blocks are home
    if (ring.current) {
      ;(ring.current.material as THREE.MeshBasicMaterial).opacity = 0.16 + 0.13 * inCount
    }
    if (!revealRef.current) {
      if (allReady) {
        dwell.current += dt
        if (dwell.current > 0.5) {
          revealRef.current = true // solved -> progression advances
          flashT.current = 1
        }
      } else {
        dwell.current = 0
      }
    }
    flashT.current = Math.max(0, flashT.current - dt * 0.7)
    if (flash.current) flash.current.intensity = flashT.current * 90
  })

  return (
    <>
      <mesh ref={ring} position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[Math.max(radius - 0.2, 0.2), radius, 56]} />
        <meshBasicMaterial color="#ffd98a" toneMapped={false} transparent opacity={0.2} side={THREE.DoubleSide} />
      </mesh>
      <pointLight ref={flash} position={[0, 2.4, 0]} distance={30} decay={2} color="#ffe9b0" intensity={0} />
    </>
  )
}

/* ---- stack puzzle: build a block up through the glowing ring ---- */
// The first room's key, teaching the core verb: lift a block and rest it on
// another so its top crosses the lit hoop. Cheese-proof — the held block is
// ignored and the top block must come to rest above the line.
const STACK_TARGET = 1.35
function StackController({
  bodies,
  dragRef,
  box,
  revealRef,
}: {
  bodies: React.MutableRefObject<Record<string, RapierRigidBody | null>>
  dragRef: React.MutableRefObject<DragState | null>
  box: Box
  revealRef: React.MutableRefObject<boolean>
}) {
  const ring = useRef<THREE.Mesh>(null)
  const flash = useRef<THREE.PointLight>(null)
  const dwell = useRef(0)
  const flashT = useRef(0)
  const r = Math.max(Math.min(box.bx, box.bz) * 0.7, 0.8)

  useEffect(() => () => {
    revealRef.current = false
  }, [revealRef])

  useFrame((_s, dt) => {
    const dragged = dragRef.current?.body ?? null
    let topY = 0
    let reached = false
    for (const b of BLOCKS) {
      const body = bodies.current[b.id]
      if (!body || body === dragged) continue // ignore the piece you're holding
      const t = body.translation()
      const lv = body.linvel()
      if (Math.hypot(lv.x, lv.y, lv.z) > 0.5) continue // must be at rest
      if (t.y > topY) topY = t.y
      if (t.y > STACK_TARGET) reached = true
    }
    if (ring.current) {
      const near = THREE.MathUtils.clamp(topY / STACK_TARGET, 0, 1)
      ;(ring.current.material as THREE.MeshBasicMaterial).opacity = reached ? 0.85 : 0.22 + 0.4 * near
    }
    if (!revealRef.current) {
      if (reached) {
        dwell.current += dt
        if (dwell.current > 0.7) {
          revealRef.current = true // solved -> progression advances
          flashT.current = 1
        }
      } else {
        dwell.current = 0
      }
    }
    flashT.current = Math.max(0, flashT.current - dt * 0.7)
    if (flash.current) flash.current.intensity = flashT.current * 90
  })

  return (
    <>
      <mesh ref={ring} position={[0, STACK_TARGET, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <torusGeometry args={[r, 0.045, 8, 56]} />
        <meshBasicMaterial color="#ffe1a8" toneMapped={false} transparent opacity={0.3} />
      </mesh>
      <pointLight ref={flash} position={[0, 2.4, 0]} distance={30} decay={2} color="#fff0cf" intensity={0} />
    </>
  )
}

// shared rest test: a block sitting still on the floor (not lifted / held)
function blockResting(body: RapierRigidBody): { x: number; z: number } | null {
  const t = body.translation()
  const lv = body.linvel()
  if (t.y > 1.4 || Math.hypot(lv.x, lv.y, lv.z) > 0.6) return null
  return { x: t.x, z: t.z }
}

/* ---- corners key: rest a block in each lit corner ---- */
function CornersController({
  bodies,
  box,
  revealRef,
}: {
  bodies: React.MutableRefObject<Record<string, RapierRigidBody | null>>
  box: Box
  revealRef: React.MutableRefObject<boolean>
}) {
  const flash = useRef<THREE.PointLight>(null)
  const pads = useRef<(THREE.Mesh | null)[]>([])
  const dwell = useRef(0)
  const flashT = useRef(0)
  const cx = Math.max(box.bx - 0.75, 0.5)
  const cz = Math.max(box.bz - 0.75, 0.5)
  const corners: [number, number][] = [
    [cx, cz],
    [cx, -cz],
    [-cx, cz],
    [-cx, -cz],
  ]
  const RAD = 1.05

  useEffect(() => () => {
    revealRef.current = false
  }, [revealRef])

  useFrame((_s, dt) => {
    const filled = corners.map(([px, pz]) =>
      BLOCKS.some((b) => {
        const body = bodies.current[b.id]
        if (!body) return false
        const r = blockResting(body)
        return !!r && Math.hypot(r.x - px, r.z - pz) < RAD
      }),
    )
    filled.forEach((on, i) => {
      const pad = pads.current[i]
      if (pad) (pad.material as THREE.MeshBasicMaterial).opacity = on ? 0.85 : 0.22
    })
    const all = filled.every(Boolean)
    if (!revealRef.current) {
      if (all) {
        dwell.current += dt
        if (dwell.current > 0.5) {
          revealRef.current = true
          flashT.current = 1
        }
      } else {
        dwell.current = 0
      }
    }
    flashT.current = Math.max(0, flashT.current - dt * 0.7)
    if (flash.current) flash.current.intensity = flashT.current * 90
  })

  return (
    <>
      {corners.map(([px, pz], i) => (
        <mesh key={i} ref={(el) => (pads.current[i] = el)} position={[px, 0.02, pz]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[RAD * 0.8, 32]} />
          <meshBasicMaterial color="#9fe6ff" toneMapped={false} transparent opacity={0.22} />
        </mesh>
      ))}
      <pointLight ref={flash} position={[0, 2.4, 0]} distance={34} decay={2} color="#bfeaff" intensity={0} />
    </>
  )
}

/* ---- line-up key: rest all five blocks along the glowing centre line ---- */
function LineupController({
  bodies,
  box,
  revealRef,
}: {
  bodies: React.MutableRefObject<Record<string, RapierRigidBody | null>>
  box: Box
  revealRef: React.MutableRefObject<boolean>
}) {
  const flash = useRef<THREE.PointLight>(null)
  const line = useRef<THREE.Mesh>(null)
  const dwell = useRef(0)
  const flashT = useRef(0)
  const BAND = 0.8 // how close to the centre line each block must rest

  useEffect(() => () => {
    revealRef.current = false
  }, [revealRef])

  useFrame((_s, dt) => {
    let onLine = 0
    let allReady = true
    for (const b of BLOCKS) {
      const body = bodies.current[b.id]
      if (!body) {
        allReady = false
        continue
      }
      const r = blockResting(body)
      if (r && Math.abs(r.z) < BAND) onLine++
      else allReady = false
    }
    if (line.current) {
      ;(line.current.material as THREE.MeshBasicMaterial).opacity = 0.18 + 0.12 * onLine
    }
    if (!revealRef.current) {
      if (allReady) {
        dwell.current += dt
        if (dwell.current > 0.5) {
          revealRef.current = true
          flashT.current = 1
        }
      } else {
        dwell.current = 0
      }
    }
    flashT.current = Math.max(0, flashT.current - dt * 0.7)
    if (flash.current) flash.current.intensity = flashT.current * 90
  })

  return (
    <>
      <mesh ref={line} position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[box.bx * 2, BAND * 2]} />
        <meshBasicMaterial color="#f4c8e6" toneMapped={false} transparent opacity={0.2} />
      </mesh>
      <pointLight ref={flash} position={[0, 2.4, 0]} distance={34} decay={2} color="#ffd8f0" intensity={0} />
    </>
  )
}

/* ---- plate key: rest any block on the glowing plate ---- */
function PlateController({
  bodies,
  revealRef,
}: {
  bodies: React.MutableRefObject<Record<string, RapierRigidBody | null>>
  revealRef: React.MutableRefObject<boolean>
}) {
  const flash = useRef<THREE.PointLight>(null)
  const plate = useRef<THREE.Mesh>(null)
  const dwell = useRef(0)
  const flashT = useRef(0)
  const RAD = 0.95

  useEffect(() => () => {
    revealRef.current = false
  }, [revealRef])

  useFrame((_s, dt) => {
    const on = BLOCKS.some((b) => {
      const body = bodies.current[b.id]
      if (!body) return false
      const r = blockResting(body)
      return !!r && Math.hypot(r.x, r.z) < RAD
    })
    if (plate.current) (plate.current.material as THREE.MeshBasicMaterial).opacity = on ? 0.9 : 0.3
    if (!revealRef.current) {
      if (on) {
        dwell.current += dt
        if (dwell.current > 0.55) {
          revealRef.current = true
          flashT.current = 1
        }
      } else {
        dwell.current = 0
      }
    }
    flashT.current = Math.max(0, flashT.current - dt * 0.7)
    if (flash.current) flash.current.intensity = flashT.current * 90
  })

  return (
    <>
      <mesh ref={plate} position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[RAD * 0.7, RAD, 40]} />
        <meshBasicMaterial color="#ffe7a0" toneMapped={false} transparent opacity={0.3} side={THREE.DoubleSide} />
      </mesh>
      <pointLight ref={flash} position={[0, 2.2, 0]} distance={28} decay={2} color="#fff0cf" intensity={0} />
    </>
  )
}

/* ---- apart key: clear the centre – scatter every block out of the ring ---- */
function ApartController({
  bodies,
  box,
  revealRef,
}: {
  bodies: React.MutableRefObject<Record<string, RapierRigidBody | null>>
  box: Box
  revealRef: React.MutableRefObject<boolean>
}) {
  const ring = useRef<THREE.Mesh>(null)
  const flash = useRef<THREE.PointLight>(null)
  const dwell = useRef(0)
  const flashT = useRef(0)
  const RAD = Math.min(1.7, Math.min(box.bx, box.bz) - 0.6)

  useEffect(() => () => {
    revealRef.current = false
  }, [revealRef])

  useFrame((_s, dt) => {
    let outCount = 0
    let allOut = true
    for (const b of BLOCKS) {
      const body = bodies.current[b.id]
      if (!body) {
        allOut = false
        continue
      }
      const r = blockResting(body)
      const clear = !!r && Math.hypot(r.x, r.z) > RAD // resting outside the centre ring
      if (clear) outCount++
      else allOut = false
    }
    if (ring.current) {
      ;(ring.current.material as THREE.MeshBasicMaterial).opacity = 0.28 - 0.045 * outCount
    }
    if (!revealRef.current) {
      if (allOut) {
        dwell.current += dt
        if (dwell.current > 0.5) {
          revealRef.current = true
          flashT.current = 1
        }
      } else {
        dwell.current = 0
      }
    }
    flashT.current = Math.max(0, flashT.current - dt * 0.7)
    if (flash.current) flash.current.intensity = flashT.current * 90
  })

  return (
    <>
      <mesh ref={ring} position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[RAD, 48]} />
        <meshBasicMaterial color="#8a8276" toneMapped={false} transparent opacity={0.28} />
      </mesh>
      <pointLight ref={flash} position={[0, 2.4, 0]} distance={32} decay={2} color="#fff2dc" intensity={0} />
    </>
  )
}

/* ---- The Five: bring each block to its slot, building the Messias figure ---- */
// Flat, top-down-readable poses (relative to centre, +z is "down/front"):
// the two blue planks are the water, the cube the pelvis, the red cylinder the
// body, the orange block the head.
const FIVE_POSE: Record<string, { pos: [number, number, number]; rot: [number, number, number] }> = {
  "plank-long": { pos: [0, 0.27, 1.3], rot: [0, Math.PI / 2, 0] },
  "plank-short": { pos: [0, 0.27, 2.0], rot: [0, Math.PI / 2, 0] },
  cube: { pos: [0, 0.54, 0.55], rot: [0, 0, 0] },
  cylinder: { pos: [0, 0.54, -0.6], rot: [Math.PI / 2, 0, 0] },
  orange: { pos: [0, 0.43, -1.8], rot: [0, 0, 0] },
}
const FIVE_ORDER = ["plank-long", "plank-short", "cube", "cylinder", "orange"]
const FIVE_CELL = 0.9 // hop step
const FIVE_BOUND = 3 // how far the active block may roam (cells)
// where each block enters from (cell), alternating sides so it isn't a straight line
const FIVE_ENTRY: [number, number][] = [
  [-2, 3],
  [2, 3],
  [-2, 3],
  [2, 3],
  [0, 3],
]
// each block moves with its own character: how far it rotates per step about the
// axis perpendicular to motion, and how long that step takes.
const FIVE_MOVE: Record<string, { angle: number; dur: number }> = {
  cube: { angle: Math.PI / 2, dur: 0.2 }, // tips 90° edge-over-edge
  cylinder: { angle: FIVE_CELL / ((30 * 0.036) / 2), dur: 0.16 }, // rolls (arc = dist / radius)
  orange: { angle: Math.PI, dur: 0.26 }, // a heavy slab flips end-over-end
  "plank-long": { angle: Math.PI, dur: 0.28 }, // long plank tumbles
  "plank-short": { angle: Math.PI, dur: 0.24 }, // short plank tumbles
}

// — The Five room: a calm stage whose mosaic floor changes per piloted block.
const fiveFloor = { idx: 0 } // signal set by FiveController -> which mosaic to show
const FIVE_MOSAICS = [
  "/textures/floors/mosaic-1.jpg",
  "/textures/floors/mosaic-2.jpg",
  "/textures/floors/mosaic-3.jpg",
  "/textures/floors/mosaic-4.jpg",
]
function FiveRoom() {
  const texs = useTexture(FIVE_MOSAICS)
  useMemo(() => {
    texs.forEach((t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping
      t.repeat.set(8, 8)
      t.colorSpace = THREE.SRGBColorSpace
      t.anisotropy = 4
    })
  }, [texs])
  const mat = useRef<THREE.MeshStandardMaterial>(null)
  const cur = useRef(-1)
  useFrame(() => {
    const i = ((fiveFloor.idx % texs.length) + texs.length) % texs.length
    if (mat.current && cur.current !== i) {
      cur.current = i
      mat.current.map = texs[i]
      mat.current.needsUpdate = true
    }
  })
  return (
    <>
      <ambientLight intensity={0.42} color="#fff1df" />
      <pointLight position={[0, 9, 1]} intensity={16} distance={42} decay={2} color="#fff0d8" />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[60, 60]} />
        {/* the mosaic, gently dimmed so the blocks + figure read on top */}
        <meshStandardMaterial ref={mat} map={texs[0]} color="#9c968c" roughness={0.92} metalness={0} />
      </mesh>
    </>
  )
}

type FiveSeat = {
  t: number
  dur: number
  id: string
  fromP: THREE.Vector3
  fromQ: THREE.Quaternion
  toP: THREE.Vector3
  toQ: THREE.Quaternion
}
// You pilot each block in turn (hop it with arrows / a held finger) from its
// entry point into its glowing slot; the Messias figure builds up piece by piece.
function FiveController({
  bodies,
  box,
  revealRef,
}: {
  bodies: React.MutableRefObject<Record<string, RapierRigidBody | null>>
  box: Box
  revealRef: React.MutableRefObject<boolean>
}) {
  const active = useRef(0)
  const placed = useRef<Set<string>>(new Set())
  const cell = useRef<[number, number]>([0, 0])
  const spawned = useRef(false)
  const heldDir = useRef<[number, number] | null>(null)
  const baseQ = useRef(new THREE.Quaternion()) // active block's accumulated orientation
  const hop = useRef<{
    t: number
    dur: number
    from: THREE.Vector3
    to: THREE.Vector3
    fromQ: THREE.Quaternion
    toQ: THREE.Quaternion
  } | null>(null)
  const seat = useRef<FiveSeat | null>(null)
  const cool = useRef(0)
  const dwell = useRef(0)
  const flash = useRef<THREE.PointLight>(null)
  const flashT = useRef(0)
  const glow = useRef<THREE.PointLight>(null)
  const CARRY = 0.75

  const slots = useMemo(() => {
    const fit = Math.min(1, (Math.min(box.bx, box.bz) - 0.5) / 2.2)
    return FIVE_ORDER.map((id) => {
      const p = FIVE_POSE[id]
      const pos = new THREE.Vector3(p.pos[0] * fit, p.pos[1], p.pos[2] * fit)
      return {
        id,
        pos,
        quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(...p.rot)),
        cellX: Math.round(pos.x / FIVE_CELL),
        cellY: Math.round(pos.z / FIVE_CELL),
      }
    })
  }, [box.bx, box.bz])

  // setup: all blocks kinematic + parked; first becomes active
  useEffect(() => {
    active.current = 0
    placed.current = new Set()
    spawned.current = false
    hop.current = null
    seat.current = null
    fiveFloor.idx = 0
    for (const b of BLOCKS) {
      const body = bodies.current[b.id]
      if (!body) continue
      body.setBodyType(BODY_KINEMATIC_POSITION, true)
      body.setNextKinematicTranslation({ x: 0, y: -80, z: 0 })
    }
    return () => {
      for (const b of BLOCKS) bodies.current[b.id]?.setBodyType(BODY_DYNAMIC, true)
      revealRef.current = false
    }
  }, [bodies, revealRef])

  // input -> a held steering direction (grid +y = world +z)
  useEffect(() => {
    const keys = new Set<string>()
    const map = (k: string) =>
      k === "arrowup" || k === "w"
        ? "up"
        : k === "arrowdown" || k === "s"
          ? "down"
          : k === "arrowleft" || k === "a"
            ? "left"
            : k === "arrowright" || k === "d"
              ? "right"
              : null
    const dirOf = (m: string | null): [number, number] | null =>
      m === "up" ? [0, -1] : m === "down" ? [0, 1] : m === "left" ? [-1, 0] : m === "right" ? [1, 0] : null
    const onDown = (e: KeyboardEvent) => {
      const m = map(e.key.toLowerCase())
      if (!m) return
      keys.add(m)
      heldDir.current = dirOf(m)
      e.preventDefault()
    }
    const onUp = (e: KeyboardEvent) => {
      const m = map(e.key.toLowerCase())
      if (!m) return
      keys.delete(m)
      heldDir.current = null
      for (const k of ["up", "down", "left", "right"]) if (keys.has(k)) heldDir.current = dirOf(k)
    }
    const dirFromTouch = (t: Touch): [number, number] | null => {
      const dx = t.clientX - window.innerWidth / 2
      const dy = t.clientY - window.innerHeight / 2
      if (Math.abs(dx) < 18 && Math.abs(dy) < 18) return heldDir.current
      return Math.abs(dx) > Math.abs(dy) ? [dx > 0 ? 1 : -1, 0] : [0, dy > 0 ? 1 : -1]
    }
    const tMove = (e: TouchEvent) => {
      const t = e.touches[0]
      if (t && e.touches.length === 1) heldDir.current = dirFromTouch(t)
    }
    const tEnd = (e: TouchEvent) => {
      if (e.touches.length === 0) heldDir.current = null
    }
    window.addEventListener("keydown", onDown)
    window.addEventListener("keyup", onUp)
    window.addEventListener("touchstart", tMove, { passive: true })
    window.addEventListener("touchmove", tMove, { passive: true })
    window.addEventListener("touchend", tEnd, { passive: true })
    window.addEventListener("touchcancel", tEnd, { passive: true })
    return () => {
      window.removeEventListener("keydown", onDown)
      window.removeEventListener("keyup", onUp)
      window.removeEventListener("touchstart", tMove)
      window.removeEventListener("touchmove", tMove)
      window.removeEventListener("touchend", tEnd)
      window.removeEventListener("touchcancel", tEnd)
    }
  }, [])

  useFrame((_s, dt) => {
    cool.current = Math.max(0, cool.current - dt)
    const idx = active.current
    fiveFloor.idx = Math.min(idx, FIVE_ORDER.length - 1) // each block gets its own mosaic floor

    // hold placed blocks at their slots; keep not-yet-active blocks hidden.
    // setTranslation (not setNextKinematic) so it works even on a sleeping body.
    slots.forEach((s, i) => {
      const body = bodies.current[s.id]
      if (!body) return
      if (body.bodyType() !== BODY_KINEMATIC_POSITION) body.setBodyType(BODY_KINEMATIC_POSITION, true)
      if (placed.current.has(s.id)) {
        body.setTranslation({ x: s.pos.x, y: s.pos.y, z: s.pos.z }, true)
        body.setRotation({ x: s.quat.x, y: s.quat.y, z: s.quat.z, w: s.quat.w }, true)
      } else if (i > idx) {
        body.setTranslation({ x: 0, y: -80, z: 0 }, true)
      }
    })

    const beginSeat = (s: (typeof slots)[number], body: RapierRigidBody) => {
      const t = body.translation()
      seat.current = {
        t: 0,
        dur: 0.35,
        id: s.id,
        fromP: new THREE.Vector3(t.x, t.y, t.z),
        fromQ: baseQ.current.clone(),
        toP: s.pos.clone(),
        toQ: s.quat.clone(),
      }
    }

    if (idx < FIVE_ORDER.length) {
      const s = slots[idx]
      const body = bodies.current[s.id]
      if (body) {
        body.wakeUp() // keep the piloted block awake so kinematic moves apply
        if (!spawned.current) {
          const [ex, ey] = FIVE_ENTRY[idx]
          cell.current = [ex, ey]
          spawned.current = true
          hop.current = null
          seat.current = null
          baseQ.current = new THREE.Quaternion()
          body.setTranslation({ x: ex * FIVE_CELL, y: CARRY, z: ey * FIVE_CELL }, true)
          body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true)
        } else if (seat.current) {
          const S = seat.current
          S.t = Math.min(S.dur, S.t + dt)
          const k = THREE.MathUtils.smoothstep(S.t / S.dur, 0, 1)
          const p = S.fromP.clone().lerp(S.toP, k)
          const q = S.fromQ.clone().slerp(S.toQ, k)
          body.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z })
          body.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
          if (S.t >= S.dur) {
            placed.current.add(S.id)
            seat.current = null
            active.current = idx + 1
            spawned.current = false
            playImpact(S.id, 0.7)
            haptic(20)
            flashT.current = Math.max(flashT.current, 0.6)
          }
        } else if (hop.current) {
          const H = hop.current
          H.t = Math.min(H.dur, H.t + dt)
          const k = H.t / H.dur
          const p = H.from.clone().lerp(H.to, k)
          p.y = CARRY + Math.sin(Math.PI * k) * 0.18 // a little arc
          const q = H.fromQ.clone().slerp(H.toQ, k) // its own tumble / roll
          body.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z })
          body.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
          if (H.t >= H.dur) {
            baseQ.current = H.toQ.clone()
            hop.current = null
            if (cell.current[0] === s.cellX && cell.current[1] === s.cellY) beginSeat(s, body)
          }
        } else {
          const [gx, gy] = cell.current
          body.setNextKinematicTranslation({ x: gx * FIVE_CELL, y: CARRY, z: gy * FIVE_CELL })
          body.setNextKinematicRotation({
            x: baseQ.current.x,
            y: baseQ.current.y,
            z: baseQ.current.z,
            w: baseQ.current.w,
          })
          if (gx === s.cellX && gy === s.cellY) {
            beginSeat(s, body)
          } else if (heldDir.current && cool.current === 0) {
            const [dx, dy] = heldDir.current
            const tx = THREE.MathUtils.clamp(gx + dx, -FIVE_BOUND, FIVE_BOUND)
            const ty = THREE.MathUtils.clamp(gy + dy, -FIVE_BOUND, FIVE_BOUND)
            if (tx !== gx || ty !== gy) {
              // rotate about the horizontal axis perpendicular to the motion
              const mv = FIVE_MOVE[s.id] ?? { angle: Math.PI / 2, dur: 0.2 }
              const axis = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx, 0, dy)).normalize()
              const step = new THREE.Quaternion().setFromAxisAngle(axis, mv.angle)
              hop.current = {
                t: 0,
                dur: mv.dur,
                from: new THREE.Vector3(gx * FIVE_CELL, CARRY, gy * FIVE_CELL),
                to: new THREE.Vector3(tx * FIVE_CELL, CARRY, ty * FIVE_CELL),
                fromQ: baseQ.current.clone(),
                toQ: step.multiply(baseQ.current),
              }
              cell.current = [tx, ty]
              cool.current = 0.05
              haptic(4)
            }
          }
        }
      }
    }

    if (!revealRef.current && placed.current.size === FIVE_ORDER.length) {
      dwell.current += dt
      if (dwell.current > 0.4) {
        revealRef.current = true
        flashT.current = 1
      }
    }
    flashT.current = Math.max(0, flashT.current - dt * 0.5)
    if (flash.current) flash.current.intensity = flashT.current * 110
    if (glow.current) glow.current.intensity = 6 + (placed.current.size / FIVE_ORDER.length) * 28 + flashT.current * 30
  })

  return (
    <>
      {/* a calm dark stage over the mosaic so the figure + slots read clearly */}
      <mesh position={[0, 0.012, 0.1]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[2.7, 56]} />
        <meshBasicMaterial color="#0a0b10" transparent opacity={0.62} />
      </mesh>
      {/* glowing slots, tinted by the block that belongs there */}
      {slots.map((s) => (
        <mesh key={s.id} position={[s.pos.x, 0.03, s.pos.z]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[0.42, 28]} />
          <meshBasicMaterial
            color={BLOCKS.find((b) => b.id === s.id)?.color ?? "#ffffff"}
            toneMapped={false}
            transparent
            opacity={0.38}
          />
        </mesh>
      ))}
      <pointLight ref={glow} position={[0, 3, 0]} distance={30} decay={2} color="#fff1dc" intensity={6} />
      <pointLight ref={flash} position={[0, 3, 0]} distance={36} decay={2} color="#fff1dc" intensity={0} />
    </>
  )
}

/* ---- a solo stage: pilot ONE block (its own move set) to the exit ---- */
const SOLO_CELL = 1.0
const SOLO_BOUND = 4
const SOLO_START: [number, number] = [-3, 3]
const SOLO_GOAL: [number, number] = [3, -3]

// Per-axis hop distance for a piloted block: a block tipping end-over-end
// pivots on its leading edge and lands a FULL footprint-length ahead, so the
// step must equal the block's own size along the direction it travels (an even
// cube steps one edge; a long plank steps its whole length down its long side).
// The cylinder keeps a uniform roll step. Returns world units [alongX, alongZ].
function soloStep(id: string): [number, number] {
  const b = BLOCKS.find((bb) => bb.id === id)
  if (!b) return [SOLO_CELL, SOLO_CELL]
  if (b.shape === "cylinder") return [SOLO_CELL, SOLO_CELL]
  return [b.half[0] * 2, b.half[2] * 2]
}

// — Solo room: a calm, plain floor + soft warm light (no photo tiles, so the
// piloted block stays the clear focus).
function SoloRoom({ env }: RoomProps) {
  const [sx, sz] = soloStep(env.solo ?? "")
  const [gx, gz] = [SOLO_GOAL[0] * sx, SOLO_GOAL[1] * sz]
  return (
    <>
      <ambientLight intensity={0.42} color="#fff1df" />
      <pointLight position={[0, 11, 2]} intensity={18} distance={55} decay={2} color="#fff0d8" />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[90, 90]} />
        <meshStandardMaterial color="#241f18" roughness={0.96} metalness={0} />
      </mesh>
      {/* the exit */}
      <mesh position={[gx, 0.03, gz]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.34, 0.5, 32]} />
        <meshBasicMaterial color="#7cf6c8" toneMapped={false} transparent opacity={0.95} side={THREE.DoubleSide} />
      </mesh>
      <pointLight position={[gx, 1.4, gz]} intensity={9} distance={7} decay={2} color="#7cf6c8" />
    </>
  )
}

function SoloController({
  blockId,
  bodies,
  revealRef,
}: {
  blockId: string
  bodies: React.MutableRefObject<Record<string, RapierRigidBody | null>>
  revealRef: React.MutableRefObject<boolean>
}) {
  const camera = useThree((s) => s.camera)
  const cell = useRef<[number, number]>([...SOLO_START])
  const heldDir = useRef<[number, number] | null>(null)
  const baseQ = useRef(new THREE.Quaternion())
  const hop = useRef<{
    t: number
    dur: number
    lift: number // arc height – taller for a longer end-over-end flip
    from: THREE.Vector3
    to: THREE.Vector3
    fromQ: THREE.Quaternion
    toQ: THREE.Quaternion
  } | null>(null)
  const cool = useRef(0)
  const camY = useRef<number | null>(null)
  const origCamY = useRef(0)
  const flash = useRef<THREE.PointLight>(null)
  const flashT = useRef(0)
  const glow = useRef<THREE.PointLight>(null)
  const landT = useRef(0)
  const CARRY = 0.55
  // each cell is one footprint-length along that axis, so a flip lands the block
  // exactly its own length ahead (the long plank covers ground down its long side)
  const [stepX, stepZ] = soloStep(blockId)

  useEffect(() => {
    cell.current = [...SOLO_START]
    hop.current = null
    heldDir.current = null
    baseQ.current = new THREE.Quaternion()
    const body = bodies.current[blockId]
    if (body) {
      body.setBodyType(BODY_KINEMATIC_POSITION, true)
      body.setTranslation({ x: SOLO_START[0] * stepX, y: CARRY, z: SOLO_START[1] * stepZ }, true)
      body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true)
    }
    return () => {
      const b = bodies.current[blockId]
      if (b) {
        b.setBodyType(BODY_DYNAMIC, true)
        b.setLinvel({ x: 0, y: 0, z: 0 }, true)
        b.setAngvel({ x: 0, y: 0, z: 0 }, true)
      }
      camera.position.x = 0
      camera.position.z = 0
      if (origCamY.current) camera.position.y = origCamY.current
      camera.lookAt(0, 0, 0)
      camY.current = null
      revealRef.current = false
    }
  }, [blockId, bodies, revealRef, camera])

  useEffect(() => {
    const keys = new Set<string>()
    const map = (k: string) =>
      k === "arrowup" || k === "w"
        ? "up"
        : k === "arrowdown" || k === "s"
          ? "down"
          : k === "arrowleft" || k === "a"
            ? "left"
            : k === "arrowright" || k === "d"
              ? "right"
              : null
    const dirOf = (m: string | null): [number, number] | null =>
      m === "up" ? [0, -1] : m === "down" ? [0, 1] : m === "left" ? [-1, 0] : m === "right" ? [1, 0] : null
    const onDown = (e: KeyboardEvent) => {
      const m = map(e.key.toLowerCase())
      if (!m) return
      keys.add(m)
      heldDir.current = dirOf(m)
      e.preventDefault()
    }
    const onUp = (e: KeyboardEvent) => {
      const m = map(e.key.toLowerCase())
      if (!m) return
      keys.delete(m)
      heldDir.current = null
      for (const k of ["up", "down", "left", "right"]) if (keys.has(k)) heldDir.current = dirOf(k)
    }
    const dirFromTouch = (t: Touch): [number, number] | null => {
      const dx = t.clientX - window.innerWidth / 2
      const dy = t.clientY - window.innerHeight / 2
      if (Math.abs(dx) < 18 && Math.abs(dy) < 18) return heldDir.current
      return Math.abs(dx) > Math.abs(dy) ? [dx > 0 ? 1 : -1, 0] : [0, dy > 0 ? 1 : -1]
    }
    const tMove = (e: TouchEvent) => {
      const t = e.touches[0]
      if (t && e.touches.length === 1) heldDir.current = dirFromTouch(t)
    }
    const tEnd = (e: TouchEvent) => {
      if (e.touches.length === 0) heldDir.current = null
    }
    window.addEventListener("keydown", onDown)
    window.addEventListener("keyup", onUp)
    window.addEventListener("touchstart", tMove, { passive: true })
    window.addEventListener("touchmove", tMove, { passive: true })
    window.addEventListener("touchend", tEnd, { passive: true })
    window.addEventListener("touchcancel", tEnd, { passive: true })
    return () => {
      window.removeEventListener("keydown", onDown)
      window.removeEventListener("keyup", onUp)
      window.removeEventListener("touchstart", tMove)
      window.removeEventListener("touchmove", tMove)
      window.removeEventListener("touchend", tEnd)
      window.removeEventListener("touchcancel", tEnd)
    }
  }, [])

  useFrame((_s, dt) => {
    const body = bodies.current[blockId]
    if (!body) return
    if (camY.current == null) {
      origCamY.current = camera.position.y
      camY.current = camera.position.y * 1.35
    }
    const cy = camY.current ?? camera.position.y
    if (body.bodyType() !== BODY_KINEMATIC_POSITION) body.setBodyType(BODY_KINEMATIC_POSITION, true)
    body.wakeUp()
    cool.current = Math.max(0, cool.current - dt)

    const atGoal = () => cell.current[0] === SOLO_GOAL[0] && cell.current[1] === SOLO_GOAL[1]

    if (hop.current) {
      const H = hop.current
      H.t = Math.min(H.dur, H.t + dt)
      const k = H.t / H.dur
      const p = H.from.clone().lerp(H.to, k)
      p.y = CARRY + Math.sin(Math.PI * k) * H.lift
      const q = H.fromQ.clone().slerp(H.toQ, k)
      body.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z })
      body.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      if (H.t >= H.dur) {
        baseQ.current = H.toQ.clone()
        hop.current = null
        landT.current = 1
        playImpact(blockId, 0.4)
        if (atGoal() && !revealRef.current) {
          revealRef.current = true
          flashT.current = 1
          haptic(26)
        }
      }
    } else {
      const [gx, gy] = cell.current
      body.setNextKinematicTranslation({ x: gx * stepX, y: CARRY, z: gy * stepZ })
      body.setNextKinematicRotation({ x: baseQ.current.x, y: baseQ.current.y, z: baseQ.current.z, w: baseQ.current.w })
      if (heldDir.current && cool.current === 0 && !revealRef.current) {
        const [dx, dy] = heldDir.current
        const tx = THREE.MathUtils.clamp(gx + dx, -SOLO_BOUND, SOLO_BOUND)
        const ty = THREE.MathUtils.clamp(gy + dy, -SOLO_BOUND, SOLO_BOUND)
        if (tx !== gx || ty !== gy) {
          const mv = FIVE_MOVE[blockId] ?? { angle: Math.PI / 2, dur: 0.2 }
          const axis = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx, 0, dy)).normalize()
          // distance travelled this hop is the footprint length along the move axis;
          // a rolling cylinder turns by arc = distance / radius, everything else
          // tips/flips by its own fixed angle (90° tip, 180° end-over-end flip)
          const dist = dx !== 0 ? stepX : stepZ
          const b = BLOCKS.find((bb) => bb.id === blockId)
          const angle = b?.shape === "cylinder" ? dist / b.radius : mv.angle
          const step = new THREE.Quaternion().setFromAxisAngle(axis, angle)
          hop.current = {
            t: 0,
            dur: mv.dur,
            // a longer flip arcs higher as it goes up and over its leading edge
            lift: 0.12 + dist * 0.16,
            from: new THREE.Vector3(gx * stepX, CARRY, gy * stepZ),
            to: new THREE.Vector3(tx * stepX, CARRY, ty * stepZ),
            fromQ: baseQ.current.clone(),
            toQ: step.multiply(baseQ.current),
          }
          cell.current = [tx, ty]
          cool.current = 0.05
          haptic(4)
        }
      }
    }

    const t = body.translation()
    camera.position.x += (t.x - camera.position.x) * 0.18
    camera.position.z += (t.z - camera.position.z) * 0.18
    camera.position.y = cy
    camera.lookAt(camera.position.x, 0, camera.position.z)

    landT.current = Math.max(0, landT.current - dt * 2.4)
    if (glow.current) {
      glow.current.position.set(t.x, t.y + 0.7, t.z)
      glow.current.intensity = 6 + landT.current * 16
    }
    flashT.current = Math.max(0, flashT.current - dt * 0.6)
    if (flash.current) {
      flash.current.position.set(SOLO_GOAL[0] * stepX, 2, SOLO_GOAL[1] * stepZ)
      flash.current.intensity = flashT.current * 120
    }
  })

  return (
    <>
      <pointLight ref={glow} distance={7} decay={2} color="#fff1dc" intensity={6} />
      <pointLight ref={flash} distance={40} decay={2} color="#7cf6c8" intensity={0} />
    </>
  )
}

// 8 — The Fourth Side room: cold TRON grid floor + walls.
function FourthRoom({ box, visibleWalls }: RoomProps) {
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { scale: { value: 9 } },
        vertexShader: CRT_VERT,
        fragmentShader: GRID_FRAG,
      }),
    [],
  )
  useEffect(() => () => mat.dispose(), [mat])
  const fw = box.bx * 2
  const fd = box.bz * 2
  return (
    <>
      <ambientLight intensity={0.22} color="#9fc4ff" />
      <directionalLight position={[4, 10, -6]} intensity={0.45} color="#cfe0ff" />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} material={mat}>
        <planeGeometry args={[fw, fd]} />
      </mesh>
      {visibleWalls.map((w, i) => (
        <mesh key={`wall-${i}`} position={w.pos} material={mat}>
          <boxGeometry args={[w.half[0] * 2, w.half[1] * 2, w.half[2] * 2]} />
        </mesh>
      ))}
    </>
  )
}

// A precise tesseract (hypercube) projection around a box of half-extents h:
// the inner cube hugs the real shape, an outer cube is the "fourth side", and
// every corner is joined to its counterpart – the classic cube-within-a-cube.
function makeTesseract(hx: number, hy: number, hz: number, s0: number, s1: number) {
  const corner = (i: number): [number, number, number] => [i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1]
  const inner: [number, number, number][] = []
  const outer: [number, number, number][] = []
  for (let i = 0; i < 8; i++) {
    const c = corner(i)
    inner.push([c[0] * hx * s0, c[1] * hy * s0, c[2] * hz * s0])
    outer.push([c[0] * hx * s1, c[1] * hy * s1, c[2] * hz * s1])
  }
  const seg: number[] = []
  for (let i = 0; i < 8; i++) {
    for (let j = i + 1; j < 8; j++) {
      const d = i ^ j
      if (d === 1 || d === 2 || d === 4) {
        seg.push(...inner[i], ...inner[j], ...outer[i], ...outer[j]) // matching edges of both cubes
      }
    }
    seg.push(...inner[i], ...outer[i]) // join the cube to its fourth-side shell
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(seg, 3))
  return g
}

// The "fourth side": one precise hyper-object per shape, slowly rotating as a
// rigid whole. Rendered as a child of the block's rigid body, so it tracks the
// shape exactly. Cold cyan; bloom makes the edges glow.
function Afterimage({ block }: { block: Block }) {
  const ref = useRef<THREE.Group>(null)
  useFrame((_s, dt) => {
    if (!ref.current) return
    ref.current.rotation.y += dt * 0.18
    ref.current.rotation.z += dt * 0.07
  })
  const half: [number, number, number] =
    block.shape === "cylinder" ? [block.radius, block.halfHeight, block.radius] : block.half
  const geom = useMemo(() => makeTesseract(half[0], half[1], half[2], 1.06, 1.7), [half[0], half[1], half[2]])
  return (
    <group ref={ref}>
      <lineSegments geometry={geom}>
        <lineBasicMaterial color="#46dcff" transparent opacity={0.6} toneMapped={false} />
      </lineSegments>
    </group>
  )
}

// 6 — Reality peel room (shader on floor + walls).
function PeelRoom({ box, visibleWalls }: RoomProps) {
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          gridScale: { value: 7 },
          peelScale: { value: 3.2 },
          wireScale: { value: 9 },
          thr: { value: 0.52 },
        },
        vertexShader: CRT_VERT,
        fragmentShader: PEEL_FRAG,
      }),
    [],
  )
  useEffect(() => () => mat.dispose(), [mat])
  const fw = box.bx * 2
  const fd = box.bz * 2
  return (
    <>
      <ambientLight intensity={0.7} color="#fff6ea" />
      <directionalLight position={[6, 9, -5]} intensity={0.5} color="#ffffff" />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} material={mat}>
        <planeGeometry args={[fw, fd]} />
      </mesh>
      {visibleWalls.map((w, i) => (
        <mesh key={`wall-${i}`} position={w.pos} material={mat}>
          <boxGeometry args={[w.half[0] * 2, w.half[1] * 2, w.half[2] * 2]} />
        </mesh>
      ))}
    </>
  )
}

// 7 — Texture-not-found room (shader patches neon-grid / missing-checker / concrete).
function TextureMissRoom({ box, visibleWalls }: RoomProps) {
  const concrete = useTexture("/textures/concrete/concrete_albedo.png")
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          concrete: { value: null },
          regionScale: { value: 2.4 },
          neonScale: { value: 9 },
          checkScale: { value: 11 },
          concreteScale: { value: 4 },
        },
        vertexShader: CRT_VERT,
        fragmentShader: MISS_FRAG,
      }),
    [],
  )
  useEffect(() => {
    concrete.wrapS = concrete.wrapT = THREE.RepeatWrapping
    concrete.needsUpdate = true
    mat.uniforms.concrete.value = concrete
  }, [concrete, mat])
  useEffect(() => () => mat.dispose(), [mat])
  const fw = box.bx * 2
  const fd = box.bz * 2
  return (
    <>
      <ambientLight intensity={0.6} color="#ffffff" />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} material={mat}>
        <planeGeometry args={[fw, fd]} />
      </mesh>
      {visibleWalls.map((w, i) => (
        <mesh key={`wall-${i}`} position={w.pos} material={mat}>
          <boxGeometry args={[w.half[0] * 2, w.half[1] * 2, w.half[2] * 2]} />
        </mesh>
      ))}
    </>
  )
}


// 5 — video room: the clip plays on loop across the floor and every wall, fed
// through a low-res CRT shader so each surface reads as an old TV display.
// The <video> + VideoTexture are created inside the effect (one per mount) so
// React StrictMode's mount/unmount/mount can't leave a dead, src-less element.
function VideoRoom({ box, visibleWalls, muted }: RoomProps) {
  const [tex, setTex] = useState<THREE.VideoTexture | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const mutedRef = useRef(muted)
  const gestured = useRef(false)
  mutedRef.current = muted
  const crt = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          map: { value: null },
          time: { value: 0 },
          res: { value: new THREE.Vector2(168, 126) },
          scan: { value: 0.36 },
          aberration: { value: 1.15 },
        },
        vertexShader: CRT_VERT,
        fragmentShader: CRT_FRAG,
      }),
    [],
  )
  useFrame((_s, dt) => {
    crt.uniforms.time.value += dt
    if (tex) crt.uniforms.map.value = tex
  })
  useEffect(() => () => crt.dispose(), [crt])
  useEffect(() => {
    if (typeof document === "undefined") return
    const v = document.createElement("video")
    v.src = "/videoplayback.mp4"
    v.loop = true
    v.muted = true
    v.defaultMuted = true
    v.playsInline = true
    v.setAttribute("muted", "")
    v.setAttribute("playsinline", "")
    v.preload = "auto"
    // in the DOM but invisible: display:none stops some browsers decoding, so
    // park it offscreen at ~0 opacity instead
    v.style.cssText = "position:fixed;width:2px;height:2px;opacity:0.01;top:0;left:0;pointer-events:none;z-index:-1"
    document.body.appendChild(v)
    videoRef.current = v

    const t = new THREE.VideoTexture(v)
    t.colorSpace = THREE.SRGBColorSpace
    t.minFilter = THREE.LinearFilter
    t.magFilter = THREE.LinearFilter
    setTex(t)

    const start = () => {
      const p = v.play()
      if (p && typeof p.catch === "function") p.catch(() => {})
    }
    // the video must autoplay MUTED; on the first gesture we unmute it to the
    // user's preference so you actually hear the clip in this room
    const onGesture = () => {
      gestured.current = true
      v.muted = mutedRef.current
      start()
    }
    start()
    window.addEventListener("pointerdown", onGesture)
    window.addEventListener("touchend", onGesture)

    return () => {
      window.removeEventListener("pointerdown", onGesture)
      window.removeEventListener("touchend", onGesture)
      v.pause()
      v.removeAttribute("src")
      v.load()
      v.remove()
      videoRef.current = null
      t.dispose()
      setTex(null)
    }
  }, [])

  // keep the clip's audio in sync with the mute button (once audio is unlocked)
  useEffect(() => {
    if (gestured.current && videoRef.current) videoRef.current.muted = muted
  }, [muted])

  const fw = box.bx * 2
  const fd = box.bz * 2
  return (
    <>
      {/* soft fill so the blocks read against the bright screens */}
      <ambientLight intensity={0.45} color="#ffffff" />
      <pointLight position={[0, 11, 0]} intensity={16} distance={36} decay={2} color="#ffffff" />

      {tex && (
        <>
          {/* floor screen – fitted to the visible tray so the clip fills the ground */}
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} material={crt}>
            <planeGeometry args={[fw, fd]} />
          </mesh>

          {/* each wall is a screen too */}
          {visibleWalls.map((w, i) => (
            <mesh key={`wall-${i}`} position={w.pos} material={crt}>
              <boxGeometry args={[w.half[0] * 2, w.half[1] * 2, w.half[2] * 2]} />
            </mesh>
          ))}
        </>
      )}
    </>
  )
}

// 1 — real concrete: photographed albedo + normal + roughness maps.
function ConcreteRoom({ visibleWalls }: RoomProps) {
  const [albedo, normal, rough] = useTexture([
    "/textures/concrete/concrete_albedo.png",
    "/textures/concrete/concrete_normal.png",
    "/textures/concrete/concrete_roughness.png",
  ])
  useMemo(() => {
    albedo.colorSpace = THREE.SRGBColorSpace
    for (const t of [albedo, normal, rough]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping
      t.repeat.set(10, 10)
      t.anisotropy = 8
      t.needsUpdate = true
    }
  }, [albedo, normal, rough])

  return (
    <>
      {/* Keep it simple: an overhead key (shared) does the work. Just a touch of
          even ambient so undersides aren't crushed – minimal indirect light. */}
      <ambientLight intensity={0.26} color="#f1ece2" />
      {/* very gentle cool fill, high up, so the shadow side isn't pure black */}
      <pointLight position={[3, 16, 3]} intensity={12} distance={42} decay={2} color="#cdd8ea" />

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[FLOOR, FLOOR]} />
        <meshPhysicalMaterial
          map={albedo}
          normalMap={normal}
          normalScale={new THREE.Vector2(0.7, 0.7)}
          roughnessMap={rough}
          roughness={1}
          metalness={0}
          sheen={0.15}
          sheenRoughness={0.9}
          sheenColor="#cfc6b4"
        />
      </mesh>

      {visibleWalls.map((w, i) => (
        <mesh key={`wall-${i}`} position={w.pos} castShadow receiveShadow>
          <boxGeometry args={[w.half[0] * 2, w.half[1] * 2, w.half[2] * 2]} />
          <meshStandardMaterial
            map={albedo}
            normalMap={normal}
            normalScale={new THREE.Vector2(0.5, 0.5)}
            roughnessMap={rough}
            roughness={1}
            metalness={0}
            color="#cfc7b6"
          />
        </mesh>
      ))}
    </>
  )
}

// 2 — gold mirror box: a real reflective floor + glowing gridded gold walls.
function GoldRoom({ visibleWalls }: RoomProps) {
  const seam = useMemo(() => makeSeamTexture(), [])
  const floorSeam = useMemo(() => {
    const t = seam.clone()
    t.repeat.set(22, 22)
    t.needsUpdate = true
    return t
  }, [seam])
  const wallSeam = useMemo(() => {
    const t = seam.clone()
    t.repeat.set(8, 3)
    t.needsUpdate = true
    return t
  }, [seam])

  return (
    <>
      <ambientLight intensity={0.12} color="#ffdba0" />
      <pointLight position={[0, 8, 0]} intensity={28} distance={30} decay={2} color="#ffd58a" />
      <pointLight position={[-4, 5, 4]} intensity={18} distance={22} decay={2} color="#ffba5a" />

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[FLOOR, FLOOR]} />
        <MeshReflectorMaterial
          resolution={1024}
          mixBlur={1}
          mixStrength={3}
          blur={[300, 110]}
          roughness={0.22}
          depthScale={0}
          metalness={0.9}
          color="#8a6a2c"
          mirror={0.85}
        />
      </mesh>
      {/* glowing seam grid floating just above the mirror */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]}>
        <planeGeometry args={[FLOOR, FLOOR]} />
        <meshBasicMaterial map={floorSeam} transparent blending={THREE.AdditiveBlending} color="#ffd98a" depthWrite={false} />
      </mesh>

      {visibleWalls.map((w, i) => (
        <mesh key={`wall-${i}`} position={w.pos} castShadow receiveShadow>
          <boxGeometry args={[w.half[0] * 2, w.half[1] * 2, w.half[2] * 2]} />
          <meshStandardMaterial
            color="#6f5420"
            metalness={0.65}
            roughness={0.32}
            emissive="#ffcf7a"
            emissiveMap={wallSeam}
            emissiveIntensity={2.2}
          />
        </mesh>
      ))}
    </>
  )
}

// 3 — backlit frosted glass-block room: pillowed bricks glowing from within.
function GlassRoom({ visibleWalls }: RoomProps) {
  // deep, rounded bevels = chunky glass bricks with glossy edges that catch light
  const brickN = useMemo(() => makeBrickNormalTexture(256, 0.28, 3.4), [])
  const brickGlow = useMemo(() => makeBrickGlowTexture(256, 0.28), [])
  const floorN = useMemo(() => {
    const t = brickN.clone()
    t.repeat.set(GLASS_FLOOR_REPEAT, GLASS_FLOOR_REPEAT)
    t.needsUpdate = true
    return t
  }, [brickN])
  const floorGlow = useMemo(() => {
    const t = brickGlow.clone()
    t.repeat.set(GLASS_FLOOR_REPEAT, GLASS_FLOOR_REPEAT)
    t.needsUpdate = true
    return t
  }, [brickGlow])
  const wallN = useMemo(() => {
    const t = brickN.clone()
    t.repeat.set(9, 3)
    t.needsUpdate = true
    return t
  }, [brickN])
  const wallGlow = useMemo(() => {
    const t = brickGlow.clone()
    t.repeat.set(9, 3)
    t.needsUpdate = true
    return t
  }, [brickGlow])

  return (
    <>
      <ambientLight intensity={0.55} color="#eef4ff" />
      <hemisphereLight intensity={0.4} color="#ffffff" groundColor="#aebccc" />
      {/* bright glow from behind the floor so the frosted bricks read as backlit */}
      <pointLight position={[0, -2.5, 0]} intensity={30} distance={26} decay={2} color="#ffffff" />
      {/* raking fills so the deep bevels pick up glossy highlights */}
      <pointLight position={[-4, 7, -3]} intensity={16} distance={26} decay={2} color="#eef6ff" />
      <pointLight position={[4, 7, 3]} intensity={12} distance={26} decay={2} color="#eef6ff" />

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[FLOOR, FLOOR]} />
        <meshPhysicalMaterial
          color="#e9f0f7"
          roughness={0.2}
          metalness={0}
          clearcoat={1}
          clearcoatRoughness={0.05}
          reflectivity={0.6}
          normalMap={floorN}
          normalScale={new THREE.Vector2(1.9, 1.9)}
          emissive="#d4e4f2"
          emissiveMap={floorGlow}
          emissiveIntensity={0.32}
        />
      </mesh>

      {visibleWalls.map((w, i) => (
        <mesh key={`wall-${i}`} position={w.pos} castShadow receiveShadow>
          <boxGeometry args={[w.half[0] * 2, w.half[1] * 2, w.half[2] * 2]} />
          <meshPhysicalMaterial
            color="#e9f0f7"
            roughness={0.24}
            metalness={0}
            clearcoat={1}
            clearcoatRoughness={0.08}
            reflectivity={0.6}
            normalMap={wallN}
            normalScale={new THREE.Vector2(1.6, 1.6)}
            emissive="#dceaf6"
            emissiveMap={wallGlow}
            emissiveIntensity={0.5}
          />
        </mesh>
      ))}
    </>
  )
}

// 4 — pastel foam play-mat: interlocking soft tiles + padded bumper walls.
function PlayMatRoom({ visibleWalls }: RoomProps) {
  const albedo = useMemo(() => makePlayMatTexture(512, 4), [])
  const puff = useMemo(() => makeBrickNormalTexture(256, 0.2, 1.4), [])
  const floorAlbedo = useMemo(() => {
    const t = albedo.clone()
    t.repeat.set(6, 6)
    t.needsUpdate = true
    return t
  }, [albedo])
  const floorN = useMemo(() => {
    const t = puff.clone()
    t.repeat.set(24, 24)
    t.needsUpdate = true
    return t
  }, [puff])
  const wallAlbedo = useMemo(() => {
    const t = albedo.clone()
    t.repeat.set(2, 1)
    t.needsUpdate = true
    return t
  }, [albedo])
  const wallN = useMemo(() => {
    const t = puff.clone()
    t.repeat.set(8, 3)
    t.needsUpdate = true
    return t
  }, [puff])

  return (
    <>
      <ambientLight intensity={0.55} color="#fff3ea" />
      <hemisphereLight intensity={0.5} color="#fffaf3" groundColor="#cfc2d6" />
      <pointLight position={[3, 12, 5]} intensity={28} distance={40} decay={2} color="#fff0e0" />

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[FLOOR, FLOOR]} />
        <meshStandardMaterial
          map={floorAlbedo}
          normalMap={floorN}
          normalScale={new THREE.Vector2(0.8, 0.8)}
          roughness={0.92}
          metalness={0}
        />
      </mesh>

      {visibleWalls.map((w, i) => (
        <mesh key={`wall-${i}`} position={w.pos} castShadow receiveShadow>
          <boxGeometry args={[w.half[0] * 2, w.half[1] * 2, w.half[2] * 2]} />
          <meshStandardMaterial
            map={wallAlbedo}
            normalMap={wallN}
            normalScale={new THREE.Vector2(0.6, 0.6)}
            roughness={0.95}
            metalness={0}
          />
        </mesh>
      ))}
    </>
  )
}

function SceneContents({
  env,
  muted,
  measureMode,
  selectedId,
  setSelectedId,
  registerReset,
  tiltRef,
  grabbingRef,
  onSolved,
}: {
  env: EnvConfig
  muted: boolean
  measureMode: boolean
  selectedId: string | null
  setSelectedId: (id: string | null) => void
  registerReset: (fn: () => void) => void
  tiltRef: React.MutableRefObject<TiltState>
  grabbingRef: React.MutableRefObject<boolean>
  onSolved?: () => void
}) {
  const { camera, gl, size } = useThree()
  const box = useBox()
  const boxRef = useRef(box)
  boxRef.current = box
  const colliderWalls = useMemo(() => buildWalls(box, WALL_COL_HEIGHT), [box])
  const visibleWalls = useMemo(() => buildWalls(box, WALL_VIS_HEIGHT), [box])
  // shadows (cast + contact) are sized to the current box so they cover the
  // whole tray and stay sharp on any window/aspect
  const shadowSpan = Math.max(box.bx, box.bz) + 1.5
  // subtle surface imperfection for the floor + walls
  const roughMap = useMemo(() => makeNoiseTexture(), [])
  const lightRef = useRef<THREE.DirectionalLight>(null)
  // user-set base position of the key light (driven by shift+right-drag) and a
  // smoothed value we actually write to the light each frame
  const lightBase = useRef(new THREE.Vector3(KEY.x, KEY.y, KEY.z))
  const lightCur = useRef(new THREE.Vector3(KEY.x, KEY.y, KEY.z))
  const bodies = useRef<Record<string, RapierRigidBody | null>>({})
  const drag = useRef<DragState | null>(null)
  // two-finger twist on a held block -> rotate it (yaw), with magnetic snapping
  // to right angles so it's easy to line up. `base` is the orientation when the
  // second finger landed; `delta` is the live yaw the servo applies on top.
  const twist = useRef<{ base: THREE.Quaternion; start: number; delta: number; active: boolean } | null>(null)
  const puzzleLock = useRef(false) // blocks become impervious during the win celebration
  const revealRef = useRef(false) // projection room: solved -> 3D forms appear in colour
  const solvedFired = useRef(false) // edge-detect the solve so onSolved fires once
  useEffect(() => {
    revealRef.current = false // reset the reveal when the environment changes
    solvedFired.current = false
  }, [env.id])
  // Watch the per-room win signals (klossete lock / projection+magnet reveal);
  // fire onSolved exactly once when a level is solved.
  useFrame(() => {
    const solved = revealRef.current || puzzleLock.current
    if (solved && !solvedFired.current) {
      solvedFired.current = true
      onSolved?.()
    } else if (!solved) {
      solvedFired.current = false
    }
  })
  const lightDragging = useRef(false)
  const pointerNdc = useRef(new THREE.Vector2())
  const raycaster = useMemo(() => new THREE.Raycaster(), [])

  // reactive-floor impact flashes (round-robin pool)
  const glowPool = useRef<Glow[]>([])
  const glowCursor = useRef(0)
  const pushGlow = useCallback((x: number, z: number, strength: number) => {
    const i = glowCursor.current % GLOW_POOL
    glowPool.current[i] = { x, z, strength, life: 1, dur: 0.55 }
    glowCursor.current++
  }, [])
  // a block striking a reactive floor lights a (dim) tile AND plays its note
  const reactive = env.reactive === true
  const onBlockImpact = useCallback(
    (x: number, z: number, strength: number) => {
      pushGlow(x, z, strength)
      if (reactive) playTone(tileFreq(x, z), strength)
    },
    [pushGlow, reactive],
  )

  /* ---- keep the shadow camera in sync when the box resizes ---- */
  useEffect(() => {
    lightRef.current?.shadow.camera.updateProjectionMatrix()
  }, [shadowSpan])

  /* ---- reset ---- */
  useEffect(() => {
    registerReset(() => {
      BLOCKS.forEach((b) => {
        const body = bodies.current[b.id]
        if (!body) return
        body.setBodyType(BODY_DYNAMIC, true)
        body.setTranslation({ x: b.pos[0], y: b.pos[1], z: b.pos[2] }, true)
        const e = new THREE.Euler(...(b.rot ?? [0, 0, 0]))
        const q = new THREE.Quaternion().setFromEuler(e)
        body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true)
        body.setLinvel({ x: 0, y: 0, z: 0 }, true)
        body.setAngvel({ x: 0, y: 0, z: 0 }, true)
      })
    })
  }, [registerReset])

  /* ---- grab ---- */
  // The body stays DYNAMIC: we hold it by a spring at the grab point so it
  // hangs and swings from the cursor under gravity instead of teleporting.
  const onGrab = useCallback(
    (body: RapierRigidBody, point: THREE.Vector3, block: Block) => {
      if (puzzleLock.current) return // impervious while the blocks celebrate
      gl.domElement.style.cursor = "grabbing"
      const t = body.translation()
      const r = body.rotation()
      const center = new THREE.Vector3(t.x, t.y, t.z)
      const q = new THREE.Quaternion(r.x, r.y, r.z, r.w)
      // grab point expressed relative to the body centre, in body-local space,
      // so we can track exactly where it has swung to each frame
      const localAnchor = point.clone().sub(center).applyQuaternion(q.clone().invert())
      // start at the height you actually grabbed (low) – it eases up to carry
      // height after a short delay rather than snapping up instantly
      const grabY = THREE.MathUtils.clamp(point.y, 0.2, MAX_LIFT)
      body.wakeUp()
      body.setLinvel({ x: 0, y: 0, z: 0 }, true)
      body.setAngvel({ x: 0, y: 0, z: 0 }, true)
      drag.current = {
        body,
        block,
        plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), -grabY),
        localAnchor,
        liftY: grabY,
        baseLift: grabY,
        grabTime: performance.now(),
        radius: blockRadius(block),
      }
      grabbingRef.current = true
      haptic(9) // a little "tick" as it lifts into your hand
    },
    [gl, grabbingRef],
  )

  /* ---- pointer tracking + light aim + release ---- */
  // The block-drag spring runs in useFrame (below); here we just keep the
  // latest cursor NDC, aim the light on shift+right-drag, and clamp on release.
  useEffect(() => {
    const el = gl.domElement

    const setNdc = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect()
      pointerNdc.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      pointerNdc.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
    }

    // place the key light wherever the cursor is: screen-right -> +x, screen-up
    // -> -z, so dragging to the top of the page lights from the top.
    const aimLight = () => {
      const n = pointerNdc.current
      lightBase.current.x = n.x * LIGHT_RADIUS
      lightBase.current.z = -n.y * LIGHT_RADIUS
    }

    const onMove = (e: PointerEvent) => {
      setNdc(e)
      if (lightDragging.current) aimLight()
    }

    const onDown = (e: PointerEvent) => {
      // shift + right (or middle) button drag re-aims the light source
      if (e.shiftKey && (e.button === 2 || e.button === 1)) {
        e.preventDefault()
        setNdc(e)
        lightDragging.current = true
        aimLight()
        try {
          el.setPointerCapture(e.pointerId)
        } catch {}
      }
    }

    const onContext = (e: MouseEvent) => {
      // keep the browser menu out of the way of shift+right-drag
      if (e.shiftKey || lightDragging.current) e.preventDefault()
    }

    const onUp = () => {
      lightDragging.current = false
      const d = drag.current
      if (!d) return
      el.style.cursor = "grab"
      // clamp the release speed so a flick stays a toss, not a hurl
      const lv = d.body.linvel()
      const v = new THREE.Vector3(lv.x, lv.y, lv.z)
      if (v.length() > THROW_MAX) {
        v.setLength(THROW_MAX)
        d.body.setLinvel({ x: v.x, y: v.y, z: v.z }, true)
      }
      drag.current = null
      twist.current = null
      grabbingRef.current = false
      haptic(6)
    }

    el.addEventListener("pointermove", onMove)
    el.addEventListener("pointerdown", onDown)
    el.addEventListener("contextmenu", onContext)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onUp)
    return () => {
      el.removeEventListener("pointermove", onMove)
      el.removeEventListener("pointerdown", onDown)
      el.removeEventListener("contextmenu", onContext)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onUp)
    }
  }, [camera, gl, raycaster, size.width, size.height])

  /* ---- pinch-to-squeeze: a 2nd finger on a held block squeezes it ---- */
  // You feel the grip (graded vibration), and letting go "pops" the block with a
  // force that scales with how hard you squeezed. (A 2-finger gesture with no
  // block held cycles environments instead – handled up in WoodenBlocks.)
  useEffect(() => {
    const el = gl.domElement
    let startDist = 0
    let squeeze = 0
    let lastBuzz = 0
    const span = (e: TouchEvent) =>
      Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY,
      )
    // angle of the line between the two fingers (screen space)
    const twoAngle = (e: TouchEvent) =>
      Math.atan2(e.touches[1].clientY - e.touches[0].clientY, e.touches[1].clientX - e.touches[0].clientX)
    const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2 && drag.current) {
        startDist = span(e)
        squeeze = 0
        const r = drag.current.body.rotation()
        twist.current = { base: new THREE.Quaternion(r.x, r.y, r.z, r.w), start: twoAngle(e), delta: 0, active: true }
      }
    }
    const onMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || !drag.current || startDist <= 0) return
      squeeze = THREE.MathUtils.clamp((startDist - span(e)) / (startDist * 0.55), 0, 1)
      const now = performance.now()
      if (squeeze > 0.05 && now - lastBuzz > 65) {
        lastBuzz = now
        haptic(2 + squeeze * 10) // tighter pinch -> stronger buzz
      }
      // twist -> free yaw (no magnetic snapping; just follow the fingers)
      const tw = twist.current
      if (tw) tw.delta = -wrap(twoAngle(e) - tw.start)
    }
    const onEnd = (e: TouchEvent) => {
      if (startDist <= 0) return
      if (e.touches.length < 2) {
        const d = drag.current
        // leave the block at exactly the angle you turned it to – no snap
        twist.current = null
        if (d && squeeze > 0.15) {
          // "pop": release the squeezed block with force proportional to squeeze
          const m = d.body.mass() || 1
          const f = squeeze * 3.4
          d.body.applyImpulse(
            { x: (Math.random() - 0.5) * 0.5 * m, y: f * m, z: (Math.random() - 0.5) * 0.5 * m },
            true,
          )
          const t = d.body.translation()
          pushGlow(t.x, t.z, 0.45 + squeeze * 0.6)
          playImpact(d.block.id, 0.5 + squeeze * 0.5)
          haptic(18 + squeeze * 24)
        }
        startDist = 0
        squeeze = 0
      }
    }
    el.addEventListener("touchstart", onStart, { passive: true })
    el.addEventListener("touchmove", onMove, { passive: true })
    el.addEventListener("touchend", onEnd)
    el.addEventListener("touchcancel", onEnd)
    return () => {
      el.removeEventListener("touchstart", onStart)
      el.removeEventListener("touchmove", onMove)
      el.removeEventListener("touchend", onEnd)
      el.removeEventListener("touchcancel", onEnd)
    }
  }, [gl, pushGlow])

  /* ---- desktop rotate: wheel / Q / E spin the held block (mirrors the twist) ---- */
  // So you can rotate a held block without a touchscreen (free yaw, no snapping).
  useEffect(() => {
    const el = gl.domElement
    const UP = new THREE.Vector3(0, 1, 0)
    const rotateHeld = (angle: number) => {
      const d = drag.current
      if (!d) return
      const r = d.body.rotation()
      const q = new THREE.Quaternion().setFromAxisAngle(UP, angle).multiply(new THREE.Quaternion(r.x, r.y, r.z, r.w))
      d.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true)
      d.body.setAngvel({ x: 0, y: 0, z: 0 }, true)
      haptic(6)
    }
    const onWheel = (e: WheelEvent) => {
      if (!drag.current) return
      e.preventDefault()
      rotateHeld((e.deltaY > 0 ? 1 : -1) * (Math.PI / 12)) // smooth 15° nudges
    }
    const onKey = (e: KeyboardEvent) => {
      if (!drag.current) return
      const k = e.key.toLowerCase()
      if (k === "q") rotateHeld(-Math.PI / 12)
      else if (k === "e") rotateHeld(Math.PI / 12)
      else return
      e.preventDefault()
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    window.addEventListener("keydown", onKey)
    return () => {
      el.removeEventListener("wheel", onWheel)
      window.removeEventListener("keydown", onKey)
    }
  }, [gl])

  /* ---- light rig: blend the shift-drag base position with the tilt offset ---- */
  useFrame(() => {
    const t = tiltRef.current
    const ox = (t.enabled ? t.sx : 0) * 7
    const oz = (t.enabled ? t.sz : 0) * 7
    const tx = lightBase.current.x + ox
    const ty = lightBase.current.y
    const tz = lightBase.current.z + oz
    lightCur.current.x += (tx - lightCur.current.x) * 0.12
    lightCur.current.y += (ty - lightCur.current.y) * 0.12
    lightCur.current.z += (tz - lightCur.current.z) * 0.12
    lightRef.current?.position.copy(lightCur.current)
  })

  /* ---- held-block spring: hang & swing the grabbed piece from the cursor ---- */
  useFrame((_state, delta) => {
    const d = drag.current
    if (!d) return
    const dt = THREE.MathUtils.clamp(delta, 1 / 240, 1 / 30)

    const held = (performance.now() - d.grabTime) / 1000
    const carry = MIN_LIFT
    const closeMax = Math.max(carry, camera.position.y - 5)
    // 1) brief delay, then ease up to carry height – the "fully picked up" beat
    const pickup = THREE.MathUtils.smoothstep(held, 0.22, 0.7)
    const carryLift = THREE.MathUtils.lerp(d.baseLift, carry, pickup)
    // 2) keep holding without letting go and it floats all the way up close,
    //    like lifting a chess piece off the board to inspect it
    const rise = THREE.MathUtils.smoothstep(held, 1.3, 4.0)
    const targetLift = THREE.MathUtils.lerp(carryLift, closeMax, rise)
    d.liftY += (targetLift - d.liftY) * 0.12
    d.plane.constant = -d.liftY

    // where the cursor wants the grab point to be (a point on the lift plane,
    // clamped inside the tray so it can't be pulled through a wall)
    raycaster.setFromCamera(pointerNdc.current, camera)
    const target = new THREE.Vector3()
    if (!raycaster.ray.intersectPlane(d.plane, target)) return
    const { bx, bz } = boxRef.current
    const lx = Math.max(bx - d.radius, 0)
    const lz = Math.max(bz - d.radius, 0)
    target.x = THREE.MathUtils.clamp(target.x, -lx, lx)
    target.z = THREE.MathUtils.clamp(target.z, -lz, lz)
    target.y = d.liftY

    // --- velocity servo: drive the grabbed point to the cursor ---
    // First-order (critically damped) so it can never overshoot or oscillate,
    // and we steer the body's VELOCITY rather than punching a point-impulse, so
    // there's no torque to set the piece shaking. Spin is damped hard so a
    // carried piece stays steady.
    const t = d.body.translation()
    const r = d.body.rotation()
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w)
    const rWorld = d.localAnchor.clone().applyQuaternion(q) // grab offset from centre
    const anchorX = t.x + rWorld.x
    const anchorY = t.y + rWorld.y
    const anchorZ = t.z + rWorld.z

    // desired carry velocity = move the grab point toward the cursor target
    let dvx = (target.x - anchorX) * GRAB_RATE
    let dvy = (target.y - anchorY) * GRAB_RATE
    let dvz = (target.z - anchorZ) * GRAB_RATE
    const dsp = Math.hypot(dvx, dvy, dvz)
    if (dsp > MAX_DRAG_SPEED) {
      const k = MAX_DRAG_SPEED / dsp
      dvx *= k
      dvy *= k
      dvz *= k
    }

    const lv = d.body.linvel()
    d.body.setLinvel(
      {
        x: lv.x + (dvx - lv.x) * GRAB_RESPONSE,
        y: lv.y + (dvy - lv.y) * GRAB_RESPONSE,
        z: lv.z + (dvz - lv.z) * GRAB_RESPONSE,
      },
      true,
    )
    const tw = twist.current
    if (tw && tw.active) {
      // a second finger is twisting: drive the yaw directly (predictable, snappy)
      // about world-Y, on top of the orientation captured when it landed
      const targetQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), tw.delta).multiply(tw.base)
      d.body.setRotation({ x: targetQ.x, y: targetQ.y, z: targetQ.z, w: targetQ.w }, true)
      d.body.setAngvel({ x: 0, y: 0, z: 0 }, true)
    } else {
      const av = d.body.angvel()
      d.body.setAngvel({ x: av.x * GRAB_ANG_DAMP, y: av.y * GRAB_ANG_DAMP, z: av.z * GRAB_ANG_DAMP }, true)
    }
  })

  /* ---- safety net: rescue any body that ever leaves the box ---- */
  // Belt-and-braces guarantee on top of the solid walls and drag clamp: if a
  // body is ever found outside the tray (a freak tunnel, a stale resize), pull
  // it back inside and kill its velocity instead of letting it vanish offscreen.
  useFrame(() => {
    if (env.maze || env.five || env.solo) return // these own their (kinematic) blocks
    const { bx, bz } = boxRef.current
    for (const b of BLOCKS) {
      const body = bodies.current[b.id]
      if (!body) continue
      if (drag.current?.body === body) continue
      const t = body.translation()
      const escaped =
        Math.abs(t.x) > bx + ESCAPE_MARGIN ||
        Math.abs(t.z) > bz + ESCAPE_MARGIN ||
        t.y < -0.5 ||
        t.y > WALL_COL_HEIGHT
      if (!escaped) continue
      const r = blockRadius(b)
      body.setTranslation(
        {
          x: THREE.MathUtils.clamp(t.x, -(bx - r), bx - r),
          y: THREE.MathUtils.clamp(t.y, r + 0.05, WALL_VIS_HEIGHT),
          z: THREE.MathUtils.clamp(t.z, -(bz - r), bz - r),
        },
        true,
      )
      body.setLinvel({ x: 0, y: 0, z: 0 }, true)
      body.setAngvel({ x: 0, y: 0, z: 0 }, true)
    }
  })

  return (
    <>
      {/* Soft KEY – the only shadow caster, aimed from the top of the page by
          default and re-aimable with shift+right-drag. Colour/intensity per env. */}
      <directionalLight
        ref={lightRef}
        position={[KEY.x, KEY.y, KEY.z]}
        intensity={env.keyIntensity}
        color={env.keyColor}
        castShadow={!env.maze}
        shadow-mapSize-width={4096}
        shadow-mapSize-height={4096}
        shadow-camera-near={1}
        shadow-camera-far={70}
        shadow-camera-left={-shadowSpan}
        shadow-camera-right={shadowSpan}
        shadow-camera-top={shadowSpan}
        shadow-camera-bottom={-shadowSpan}
        shadow-bias={-0.00015}
        shadow-normalBias={0.04}
      />

      {/* soft contact shadow that grounds the blocks; sized to the box */}
      <ContactShadows
        position={[0, 0.001, 0]}
        scale={shadowSpan * 2}
        resolution={2048}
        far={4}
        blur={2.4}
        opacity={env.contact.opacity}
        color={env.contact.color}
      />

      <TiltController tiltRef={tiltRef} zeroG={env.magnet === true} />

      {/* static world: floor + tall invisible containment walls */}
      {/* dead, non-bouncy containment: solid walls that hold blocks in without
          ever shoving them around (no restitution -> no "push") */}
      <RigidBody type="fixed" colliders={false} friction={0.8} restitution={0}>
        {/* the space level has no floor – pieces float freely (the magnet room's
            own edge force-field keeps them on screen) */}
        {!env.magnet && !env.maze && !env.solo && <CuboidCollider args={[60, 1, 60]} position={[0, -1, 0]} />}
        {!env.magnet &&
          !env.maze &&
          !env.solo &&
          colliderWalls.map((w, i) => (
            <CuboidCollider key={i} args={w.half} position={w.pos} restitution={0} />
          ))}
      </RigidBody>

      {/* environment-specific room: floor, walls, fill lighting */}
      <Room env={env} box={box} visibleWalls={visibleWalls} shadowSpan={shadowSpan} roughMap={roughMap} muted={muted} />

      {/* reactive floor: tiles flash where blocks strike, brightness ~ force */}
      <ImpactGlows poolRef={glowPool} active={!!env.reactive} tile={GLASS_TILE} />

      {/* klossete sorting puzzle: win detection + Morse lightbulb celebration */}
      {env.puzzle && <PuzzleController bodies={bodies} box={box} lockRef={puzzleLock} />}

      {/* projection puzzle: colour projections under the colourless blocks */}
      {env.projection && <ProjectionController bodies={bodies} box={box} revealRef={revealRef} />}

      {/* magnet/totem puzzle: gentle pairwise snaps assemble a figure */}
      {env.magnet && <MagnetController bodies={bodies} box={box} dragRef={drag} revealRef={revealRef} />}

      {/* maze: one block flip-flops through corridors, camera following, to the exit */}
      {env.maze && <MazeController bodies={bodies} revealRef={revealRef} />}

      {/* gather: rest all five blocks on the glowing pad to solve */}
      {env.gather && <GatherController bodies={bodies} box={box} revealRef={revealRef} />}

      {/* stack: build a block up through the glowing ring to solve */}
      {env.stack && <StackController bodies={bodies} dragRef={drag} box={box} revealRef={revealRef} />}

      {/* corners: rest a block in each lit corner */}
      {env.corners && <CornersController bodies={bodies} box={box} revealRef={revealRef} />}

      {/* line-up: rest all five blocks along the centre line */}
      {env.lineup && <LineupController bodies={bodies} box={box} revealRef={revealRef} />}

      {/* plate: rest a block on the glowing plate */}
      {env.plate && <PlateController bodies={bodies} revealRef={revealRef} />}

      {/* apart: scatter every block out of the centre ring */}
      {env.apart && <ApartController bodies={bodies} box={box} revealRef={revealRef} />}

      {/* The Five: pilot each block to its slot to build the Messias figure */}
      {env.five && <FiveController bodies={bodies} box={box} revealRef={revealRef} />}

      {/* solo stage: pilot just one block (its own move set) to the exit */}
      {env.solo && <SoloController blockId={env.solo} bodies={bodies} revealRef={revealRef} />}

      {/* blocks — a solo stage shows only its one block; the maze only the cube */}
      {BLOCKS.filter((b) => (env.solo ? b.id === env.solo : !env.maze || b.id === "cube")).map((b) => (
        <BlockBody
          key={b.id}
          block={b}
          bodyRef={(r) => (bodies.current[b.id] = r)}
          onGrab={onGrab}
          onImpact={onBlockImpact}
          knock={!reactive}
          showAfterimage={env.fourthSide === true}
          flat={env.projection === true}
          revealRef={revealRef}
          measureMode={measureMode}
          selected={selectedId === b.id}
          onSelect={(id) => setSelectedId(id)}
        />
      ))}

      {/* tap empty space to clear measurement */}
      {measureMode && (
        <mesh position={[0, -0.5, 0]} rotation={[-Math.PI / 2, 0, 0]} onPointerDown={() => setSelectedId(null)}>
          <planeGeometry args={[200, 200]} />
          <meshBasicMaterial visible={false} />
        </mesh>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/*  Public component                                                   */
/* ------------------------------------------------------------------ */
export default function WoodenBlocks({
  initialLevel,
  initialMuted = false,
  initialTilt = false,
  onExit,
}: {
  initialLevel?: number
  initialMuted?: boolean
  initialTilt?: boolean
  onExit?: () => void
} = {}) {
  const [measureMode, setMeasureMode] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tiltOn, setTiltOn] = useState(false)
  const [muted, setMutedState] = useState(initialMuted)
  const [envIndex, setEnvIndex] = useState(0)
  const env = ENVIRONMENTS[envIndex] ?? ENVIRONMENTS[0] // never crash on a stale/out-of-range index
  const resetRef = useRef<() => void>(() => {})
  // linear progression: remember the live level for stable callbacks + guard
  const currentRef = useRef(0)
  currentRef.current = envIndex
  const advancing = useRef(false)

  // A level was solved (its secret found): record it, let the victory play, then
  // advance to the next level and reset the pieces. Manual navigation still works
  // for the rooms that don't yet have a key.
  const onSolved = useCallback(() => {
    if (advancing.current) return
    advancing.current = true
    const solvedId = ENVIRONMENTS[currentRef.current]?.id
    if (solvedId) markSolved(solvedId)
    window.setTimeout(() => {
      const next = Math.min(currentRef.current + 1, ENVIRONMENTS.length - 1)
      setCurrent(Math.max(getProgress().current, next)) // never regress saved progress when replaying
      setEnvIndex(next)
      resetRef.current()
      advancing.current = false
    }, 2600)
  }, [])
  const tiltRef = useRef<TiltState>({ enabled: false, beta: 0, gamma: 0, sx: 0, sz: 0 })
  const iconRef = useRef<HTMLSpanElement>(null)
  // true while a block is held – so a 2nd finger squeezes it instead of the
  // two-finger gesture cycling the environment
  const grabbingRef = useRef(false)

  // The control cluster fades itself out when idle and fades back in when the
  // pointer comes near the corner, so it stays out of the way of the toy.
  const [uiShown, setUiShown] = useState(true)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const revealUI = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = null
    setUiShown(true)
  }, [])
  const scheduleHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setUiShown(false), 2200)
  }, [])
  useEffect(() => {
    scheduleHide() // visible on load, then fade out after a beat
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [scheduleHide])

  // Reveal the cluster when the pointer enters the bottom-right corner, and
  // re-arm the fade when it leaves – proximity, not a hover hit-test, so the
  // hidden cluster can stay pointer-events-none and never swallow a drag.
  const wasNear = useRef(false)
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const near = window.innerWidth - e.clientX < 160 && window.innerHeight - e.clientY < 280
      if (near && !wasNear.current) {
        wasNear.current = true
        revealUI()
      } else if (!near && wasNear.current) {
        wasNear.current = false
        scheduleHide()
      }
    }
    window.addEventListener("pointermove", onMove)
    return () => window.removeEventListener("pointermove", onMove)
  }, [revealUI, scheduleHide])

  // Browsers only let audio start from a user gesture. iOS is especially fussy –
  // the first tap often doesn't take, so we retry on several gesture types
  // (touchend is the reliable one on iOS) until the context is actually running.
  useEffect(() => {
    const unlock = () => {
      unlockAudio()
      primeBlocks(BLOCKS.map((b) => ({ id: b.id, freq: blockBaseFreq(b) })))
      if (audioReady()) cleanup()
    }
    const cleanup = () => {
      window.removeEventListener("pointerdown", unlock)
      window.removeEventListener("touchstart", unlock)
      window.removeEventListener("touchend", unlock)
      window.removeEventListener("click", unlock)
    }
    window.addEventListener("pointerdown", unlock, { passive: true })
    window.addEventListener("touchstart", unlock, { passive: true })
    window.addEventListener("touchend", unlock, { passive: true })
    window.addEventListener("click", unlock, { passive: true })
    return cleanup
  }, [])

  // Open at the requested level (from the level-select grid) or, failing that,
  // resume at the saved level. Done in an effect (not in useState) so server +
  // client first render agree – no hydration mismatch.
  useEffect(() => {
    const want = initialLevel ?? getProgress().current
    setEnvIndex(Math.max(0, Math.min(want, ENVIRONMENTS.length - 1)))
  }, [initialLevel])

  // Environment navigation: number keys 1-9 jump straight to an environment
  // (desktop); a two-finger tap-and-hold cycles to the next one (touch).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key >= "1" && e.key <= "9") {
        const idx = Number(e.key) - 1
        if (idx < ENVIRONMENTS.length) setEnvIndex(idx)
      }
    }
    let holdTimer: ReturnType<typeof setTimeout> | null = null
    let start: { x: number; y: number } | null = null
    const clearHold = () => {
      if (holdTimer) clearTimeout(holdTimer)
      holdTimer = null
    }
    const onTouchStart = (e: TouchEvent) => {
      // two fingers with NO block held = cycle environment; if a block is held a
      // 2nd finger is a squeeze (handled in SceneContents), so don't cycle.
      if (e.touches.length === 2 && !grabbingRef.current) {
        start = { x: e.touches[0].clientX, y: e.touches[0].clientY }
        clearHold()
        holdTimer = setTimeout(() => setEnvIndex((i) => (i + 1) % ENVIRONMENTS.length), 450)
      } else {
        clearHold()
      }
    }
    const onTouchMove = (e: TouchEvent) => {
      if (!holdTimer || e.touches.length < 2 || !start) {
        clearHold()
        return
      }
      const moved = Math.hypot(e.touches[0].clientX - start.x, e.touches[0].clientY - start.y)
      if (moved > 24) clearHold() // it's a pinch/drag, not a hold
    }
    const onTouchEnd = () => clearHold()
    window.addEventListener("keydown", onKey)
    window.addEventListener("touchstart", onTouchStart, { passive: true })
    window.addEventListener("touchmove", onTouchMove, { passive: true })
    window.addEventListener("touchend", onTouchEnd)
    window.addEventListener("touchcancel", onTouchEnd)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("touchstart", onTouchStart)
      window.removeEventListener("touchmove", onTouchMove)
      window.removeEventListener("touchend", onTouchEnd)
      window.removeEventListener("touchcancel", onTouchEnd)
      clearHold()
    }
  }, [])

  // While tilt is on, lean the phone icon the same way gravity is pulling on
  // screen (using the calibrated screen-space tilt), so it tips toward where the
  // blocks pour instead of sideways.
  useEffect(() => {
    const el = iconRef.current
    if (!tiltOn) {
      if (el) el.style.transform = ""
      return
    }
    let raf = 0
    const cur = { x: 0, z: 0 }
    const loop = () => {
      const t = tiltRef.current
      cur.x += (t.sx - cur.x) * 0.18
      cur.z += (t.sz - cur.z) * 0.18
      const ry = Math.max(-50, Math.min(50, cur.x * 60)) // lean toward screen-right pull
      const rx = Math.max(-50, Math.min(50, cur.z * 60)) // lean toward screen-down pull
      if (iconRef.current) {
        iconRef.current.style.transform = `perspective(140px) rotateY(${ry}deg) rotateX(${rx}deg)`
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [tiltOn])

  const onOrient = useCallback((e: DeviceOrientationEvent) => {
    tiltRef.current.beta = e.beta ?? 0
    tiltRef.current.gamma = e.gamma ?? 0
  }, [])

  useEffect(() => {
    return () => window.removeEventListener("deviceorientation", onOrient)
  }, [onOrient])

  const enableTilt = useCallback(() => {
    window.addEventListener("deviceorientation", onOrient)
    tiltRef.current.enabled = true
    setTiltOn(true)
  }, [onOrient])

  const toggleTilt = useCallback(async () => {
    if (tiltOn) {
      window.removeEventListener("deviceorientation", onOrient)
      tiltRef.current.enabled = false
      setTiltOn(false)
      setTiltPref(false)
      return
    }

    // iOS 13+ requires an explicit permission request from a user gesture
    const DOE = window.DeviceOrientationEvent as any
    try {
      if (DOE && typeof DOE.requestPermission === "function") {
        const res = await DOE.requestPermission()
        if (res !== "granted") return
      }
    } catch {
      return
    }

    enableTilt()
    setTiltPref(true)
  }, [tiltOn, onOrient, enableTilt])

  // Honour the menu's saved preferences on entry: start muted/tilted if the
  // player chose so on the title screen (tilt permission was already granted
  // there, so we can attach the listener straight away).
  useEffect(() => {
    setMuted(initialMuted)
    if (initialTilt) enableTilt()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      className="relative h-dvh w-full overflow-hidden transition-colors duration-700"
      style={{ backgroundColor: env.bg }}
    >
      <Canvas
        shadows
        dpr={[1, 1.75]}
        gl={{ antialias: true, preserveDrawingBuffer: false, powerPreference: "high-performance" }}
        camera={{ position: [0, 30, 0], fov: CAM_FOV, near: 0.1, far: 200 }}
        onCreated={({ gl }) => {
          // tone mapping is handled by the post-processing ToneMapping effect
          gl.toneMapping = THREE.NoToneMapping
          gl.domElement.style.cursor = "grab"
        }}
        style={{ touchAction: "none" }}
      >
        <color attach="background" args={[env.bg]} />
        <CameraRig />
        <Physics
          gravity={[0, -G, 0]}
          timeStep={1 / 120}
          numSolverIterations={12}
          maxCcdSubsteps={4}
          interpolate
        >
          <Suspense fallback={null}>
            <SceneContents
              env={env}
              muted={muted}
              measureMode={measureMode}
              selectedId={selectedId}
              setSelectedId={setSelectedId}
              registerReset={(fn) => (resetRef.current = fn)}
              tiltRef={tiltRef}
              grabbingRef={grabbingRef}
              onSolved={onSolved}
            />
          </Suspense>
        </Physics>

        {/* shared realism post-processing (AO, bloom, vignette, ACES, SMAA) */}
        <PostFx envId={env.id} />
      </Canvas>

      {/* UI – control cluster pinned to the top-left corner. Always faintly
          visible so it's never lost, brightening when the pointer comes near.
          It stays interactive at all times (the buttons are small enough not to
          get in the way of the toy). */}
      <div
        onPointerEnter={revealUI}
        onPointerLeave={scheduleHide}
        style={{ color: env.id === "gold" ? "#efe1c2" : "#262626" }}
        className={`pointer-events-auto absolute left-2 top-2 z-10 flex flex-col gap-2 p-1 transition-opacity duration-700 ease-out ${
          uiShown ? "opacity-90" : "opacity-30"
        }`}
      >
        {onExit && (
          <button
            type="button"
            aria-label="Tilbake til nivå"
            onClick={onExit}
            className="flex h-11 w-11 items-center justify-center rounded-full transition hover:bg-black/5 active:scale-95"
          >
            <LayoutGrid className="h-5 w-5" strokeWidth={2.4} />
          </button>
        )}
        <button
          type="button"
          aria-label={muted ? "Slå på lyd" : "Demp lyd"}
          aria-pressed={muted}
          onClick={() => {
            const next = !muted
            setMutedState(next)
            setMuted(next)
            setSound(!next) // keep the menu's saved preference in sync
          }}
          className="flex h-11 w-11 items-center justify-center rounded-full transition hover:bg-black/5 active:scale-95"
        >
          {muted ? (
            <VolumeX className="h-5 w-5" strokeWidth={2.4} />
          ) : (
            <Volume2 className="h-5 w-5" strokeWidth={2.4} />
          )}
        </button>
        <button
          type="button"
          aria-label="Vipp for å styre tyngdekrafta"
          aria-pressed={tiltOn}
          onClick={toggleTilt}
          className={`flex h-11 w-11 items-center justify-center rounded-full transition active:scale-95 ${
            tiltOn ? "bg-black/10" : "hover:bg-black/5"
          }`}
        >
          <span ref={iconRef} className="flex items-center justify-center [transform-style:preserve-3d]">
            <Smartphone className="h-5 w-5" strokeWidth={2.4} />
          </span>
        </button>
      </div>

    </div>
  )
}
