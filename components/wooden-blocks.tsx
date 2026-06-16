"use client"

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Canvas, useThree, useFrame } from "@react-three/fiber"
import { ContactShadows, Html, MeshReflectorMaterial, useGLTF, useTexture } from "@react-three/drei"
import { Bloom, EffectComposer, N8AO, SMAA, ToneMapping, Vignette } from "@react-three/postprocessing"
import { ToneMappingMode } from "postprocessing"
import {
  Physics,
  RigidBody,
  CuboidCollider,
  CylinderCollider,
  useRapier,
  type RapierRigidBody,
} from "@react-three/rapier"
import * as THREE from "three"
import { Layers, Smartphone, Volume2, VolumeX } from "lucide-react"
import { audioReady, playBeep, playImpact, playTone, primeBlocks, setMuted, unlockAudio } from "@/lib/impact-sound"

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

/* ------------------------------------------------------------------ */
/*  Block catalogue – sizes are real millimetres scaled to scene units */
/* ------------------------------------------------------------------ */
const S = 0.045 // 1 mm -> scene units (blocks sit comfortably inside the tray)

type BlockMeshAsset = {
  url: string
}

type BlockBase = {
  id: string
  name: string
  color: string
  dims: string
  pos: [number, number, number]
  rot?: [number, number, number]
  mesh: BlockMeshAsset
}

type BoxBlock = {
  shape: "box"
  half: [number, number, number]
} & BlockBase
type CylBlock = {
  shape: "cylinder"
  radius: number
  halfHeight: number
} & BlockBase
type Block = BoxBlock | CylBlock

const MESHES = {
  cube: {
    url: "/block_lightblue_cube.glb",
  },
  orange: {
    url: "/block_orange.glb",
  },
  blueLong: {
    url: "/block_blue_02.glb",
  },
  blueShort: {
    url: "/block_blue_01.glb",
  },
  cylinder: {
    url: "/block_red_cylinder.glb",
  },
} satisfies Record<string, BlockMeshAsset>

const REST = 0.06 // small gap above floor when spawning

const BLOCKS: Block[] = [
  {
    id: "cube",
    name: "Light Blue Cube",
    color: "#3f9ec9",
    shape: "box",
    half: [(30 * S) / 2, (30 * S) / 2, (30 * S) / 2],
    dims: "30 × 30 × 30 mm",
    pos: [-1.48, (30 * S) / 2 + REST, -2.96],
    mesh: MESHES.cube,
  },
  {
    id: "orange",
    name: "Orange Block",
    color: "#e07b22",
    shape: "box",
    // 45 × 45 × 24, lying so the 24 mm dimension is the height
    half: [(45 * S) / 2, (24 * S) / 2, (45 * S) / 2],
    dims: "45 × 45 × 24 mm",
    pos: [-0.84, (24 * S) / 2 + REST, 0.26],
    mesh: MESHES.orange,
  },
  {
    id: "plank-long",
    name: "Dark Blue Plank",
    color: "#2f63cc",
    shape: "box",
    // 30 × 75 × 15, lying flat. Spawn rotated so the 75 mm length starts across the tray.
    half: [(30 * S) / 2, (15 * S) / 2, (75 * S) / 2],
    dims: "30 × 75 × 15 mm",
    pos: [0.19, (15 * S) / 2 + REST, 3.21],
    rot: [0, Math.PI / 2, 0],
    mesh: MESHES.blueLong,
  },
  {
    id: "plank-short",
    name: "Dark Blue Short",
    color: "#2f63cc",
    shape: "box",
    // 30 × 60 × 15, lying flat (60 along z, 30 along x, 15 high)
    half: [(30 * S) / 2, (15 * S) / 2, (60 * S) / 2],
    dims: "30 × 60 × 15 mm",
    pos: [1.29, (15 * S) / 2 + REST, -1.48],
    mesh: MESHES.blueShort,
  },
  {
    id: "cylinder",
    name: "Red Cylinder",
    color: "#c83a2e",
    shape: "cylinder",
    radius: (30 * S) / 2,
    halfHeight: (60 * S) / 2,
    dims: "Ø 30 mm · H 60 mm",
    pos: [1.22, (60 * S) / 2 + REST, 1.93],
    mesh: MESHES.cylinder,
  },
]

/* ------------------------------------------------------------------ */
/*  Camera + tray layout – the single source of truth                  */
/*                                                                     */
/*  The camera looks straight down at the origin, so the visible floor */
/*  is an axis-aligned rectangle centred on (0,0). We derive its half  */
/*  extents analytically (no raycasting), build a clean rectangular    */
/*  tray from them, and reuse the EXACT same numbers to clamp dragging */
/*  and to catch any body that ever escapes – so the box, the camera   */
/*  and the containment logic can never drift apart.                   */
/* ------------------------------------------------------------------ */
const CAM_FOV = 36
// How many world units to keep visible. Smaller = camera tighter = blocks read
// BIGGER on screen. Phones get a tighter frame so the blocks aren't tiny.
const TARGET_HALF_DESKTOP = 4.4
function viewTarget(w: number, h: number) {
  const min = Math.min(w, h)
  if (min < 520) return 2.8 // phones
  if (min < 820) return 3.6 // small tablets
  return TARGET_HALF_DESKTOP
}
const BOX_INSET = 0.9 // pull the walls inward so the whole frame reads on screen
const WALL_HALF_THICK = 0.4
const WALL_VIS_HEIGHT = 3.0 // the wood-coloured tray walls you actually see
const WALL_COL_HEIGHT = 16 // invisible containment walls – a deep box nothing escapes

// Half extents of the inner wall faces: the playable rectangle on the floor.
type Box = { bx: number; bz: number }

function boxLayout(aspect: number, target: number) {
  const halfV = Math.tan((CAM_FOV / 2) * (Math.PI / 180))
  const dist = Math.max(target / (halfV * aspect), target / halfV) + 0.5
  const halfX = dist * halfV * aspect
  const halfZ = dist * halfV
  return { dist, bx: halfX * BOX_INSET, bz: halfZ * BOX_INSET }
}

function useBox(): Box {
  const size = useThree((s) => s.size)
  return useMemo(() => {
    const { bx, bz } = boxLayout(size.width / size.height, viewTarget(size.width, size.height))
    return { bx, bz }
  }, [size.width, size.height])
}

type Wall = { half: [number, number, number]; pos: [number, number, number] }

// Four axis-aligned walls whose inner faces sit exactly on ±bx / ±bz.
function buildWalls({ bx, bz }: Box, height: number): Wall[] {
  const t = WALL_HALF_THICK
  const h = height / 2
  return [
    { half: [t, h, bz + 2 * t], pos: [-(bx + t), h, 0] }, // left
    { half: [t, h, bz + 2 * t], pos: [bx + t, h, 0] }, // right
    { half: [bx + 2 * t, h, t], pos: [0, h, -(bz + t)] }, // back
    { half: [bx + 2 * t, h, t], pos: [0, h, bz + t] }, // front
  ]
}

// Horizontal bounding radius of a block – the margin to keep it off the walls
// no matter how it is rotated about the vertical axis.
function blockRadius(b: Block) {
  return b.shape === "cylinder" ? b.radius : Math.hypot(b.half[0], b.half[2])
}

// Largest real dimension of a block in mm – longer pieces ring at a lower pitch.
function blockMaxMm(b: Block) {
  const u = b.shape === "cylinder" ? Math.max(b.radius * 2, b.halfHeight * 2) : Math.max(...b.half) * 2
  return u / S
}

// Fundamental impact frequency: bigger block -> lower knock.
function blockBaseFreq(b: Block) {
  return THREE.MathUtils.clamp(2600 / Math.sqrt(blockMaxMm(b)), 230, 680)
}

function BlockMesh({
  block,
  onPointerDown,
}: {
  block: Block
  onPointerDown: (e: any) => void
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

  return (
    <group onPointerDown={onPointerDown}>
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
      restitution={0.12}
      density={6}
      linearDamping={0.12}
      angularDamping={0.7}
      canSleep={false}
      onCollisionEnter={handleImpact}
      ccd
    >
      {block.shape === "box" ? (
        <>
          <CuboidCollider args={block.half} />
          <BlockMesh block={block} onPointerDown={handlePointerDown} />
        </>
      ) : (
        <>
          <CylinderCollider args={[block.halfHeight, block.radius]} />
          <BlockMesh block={block} onPointerDown={handlePointerDown} />
        </>
      )}

      {showAfterimage && <Afterimage block={block} />}

      {measureMode && selected && (
        <Html position={[0, labelY, 0]} center distanceFactor={10} zIndexRange={[100, 0]}>
          <div className="pointer-events-none select-none whitespace-nowrap rounded-md border border-black/5 bg-background/95 px-2.5 py-1.5 text-center shadow-lg">
            <span className="block text-[9px] font-bold uppercase tracking-wide text-muted-foreground">
              {block.name}
            </span>
            <span className="text-xs font-medium text-foreground">{block.dims}</span>
          </div>
        </Html>
      )}
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
const KEY = { x: -2.5, y: 17, z: -9 }

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
type EnvKind = "concrete" | "gold" | "glass" | "playmat" | "video" | "peel" | "texturemiss" | "fourthside" | "klossete"
type EnvConfig = {
  id: EnvKind
  name: string
  bg: string // canvas + page background
  keyColor: string
  keyIntensity: number
  contact: { color: string; opacity: number } // grounding contact shadow
  bloom: boolean
  reactive?: boolean // tiles flash with light where a block hits (brightness ~ force)
  fourthSide?: boolean // wraps each block in glowing wireframe "4D" shells
  puzzle?: boolean // sort each block onto its zone -> they blink "KLOSSETE" in Morse
}
const ENVIRONMENTS: EnvConfig[] = [
  {
    id: "concrete",
    name: "Concrete",
    bg: "#cdc6b8",
    keyColor: "#fff1df",
    keyIntensity: 3.1,
    contact: { color: "#332b20", opacity: 0.5 },
    bloom: false,
  },
  {
    id: "gold",
    name: "Gold mirror",
    bg: "#0c0a06",
    keyColor: "#ffdca0",
    keyIntensity: 2.4,
    contact: { color: "#000000", opacity: 0.35 },
    bloom: true,
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
  },
  {
    id: "playmat",
    name: "Play mat",
    bg: "#e7e0ec",
    keyColor: "#fff4ea",
    keyIntensity: 2.5,
    contact: { color: "#5a4f63", opacity: 0.34 },
    bloom: false,
  },
  {
    id: "video",
    name: "Video room",
    bg: "#000000",
    keyColor: "#ffffff",
    keyIntensity: 1.5,
    contact: { color: "#000000", opacity: 0.45 },
    bloom: true,
  },
  {
    id: "peel",
    name: "Reality peel",
    bg: "#cbc6b9",
    keyColor: "#fff4e6",
    keyIntensity: 2.2,
    contact: { color: "#37332a", opacity: 0.3 },
    bloom: false,
  },
  {
    id: "texturemiss",
    name: "Texture not found",
    bg: "#060609",
    keyColor: "#ffffff",
    keyIntensity: 1.8,
    contact: { color: "#000000", opacity: 0.4 },
    bloom: true,
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
]

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
}: {
  tiltRef: React.MutableRefObject<TiltState>
}) {
  const { world } = useRapier()
  const cur = useRef({ beta: 0, gamma: 0 })
  // Self-calibrated "down the screen" direction in the device's native in-plane
  // basis (right, down). Device/OS orientation reporting is unreliable across
  // phones and iPads, so instead of trusting screen.orientation.angle we learn
  // which way is down from where gravity actually pulls when tilt is engaged.
  const down = useRef<{ x: number; y: number } | null>(null)

  useFrame(() => {
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
   the grab point while gravity pulls the centre of mass, the piece hangs and
   swings from your cursor like it's on a string. It's responsive enough to
   position and stack precisely, but the RELEASE speed is clamped low so a flick
   can never become a fling. */
const DRAG_K = 185 // spring stiffness (how eagerly the grab point chases the cursor)
const DRAG_C = 44 // damping (over-critical -> smooth, no shake/jitter while held)
const DRAG_ERR_MAX = 1.5 // cap on position error -> caps the pull force
const DRAG_ACCEL_MAX = 230 // ceiling on grab acceleration
const MAX_DRAG_SPEED = 7 // linear speed cap while held – responsive but steady
const MAX_DRAG_ANGSPEED = 4.5 // spin cap while held (lower = calmer)
const LIGHT_RADIUS = 14 // how far the key light orbits when you shift+right-drag it

/* ------------------------------------------------------------------ */
/*  Room environments – floor + walls + fill lighting, swapped by env   */
/* ------------------------------------------------------------------ */
const FLOOR = 120

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
  if (props.env.id === "gold") return <GoldRoom {...props} />
  if (props.env.id === "glass") return <GlassRoom {...props} />
  if (props.env.id === "playmat") return <PlayMatRoom {...props} />
  if (props.env.id === "video") return <VideoRoom {...props} />
  if (props.env.id === "peel") return <PeelRoom {...props} />
  if (props.env.id === "texturemiss") return <TextureMissRoom {...props} />
  if (props.env.id === "fourthside") return <FourthRoom {...props} />
  if (props.env.id === "klossete") return <KlosseRoom {...props} />
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

/* CRT / low-res TV shader for the video screens: chunky pixels, scanlines,
   RGB-subpixel bleed, flicker + static, and a per-screen vignette. */
const CRT_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
const CRT_FRAG = /* glsl */ `
  precision mediump float;
  uniform sampler2D map;
  uniform float time;
  uniform vec2 res;        // pixel grid of the "screen"
  uniform float scan;      // scanline depth
  uniform float aberration;
  varying vec2 vUv;

  float rand(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

  void main() {
    // chunky low-res pixels
    vec2 puv = (floor(vUv * res) + 0.5) / res;
    // chromatic aberration – split the channels by a pixel or so
    vec2 off = vec2(aberration) / res;
    float r = texture2D(map, puv + off).r;
    float g = texture2D(map, puv).g;
    float b = texture2D(map, puv - off).b;
    vec3 col = vec3(r, g, b);

    // scanlines + faint vertical aperture grille
    float sl = 0.5 + 0.5 * cos(vUv.y * res.y * 6.2831853);
    col *= 1.0 - scan * (1.0 - sl);
    col *= 1.0 - 0.10 * (0.5 + 0.5 * cos(vUv.x * res.x * 6.2831853));

    // rolling brightness flicker + a little analogue static
    col *= 0.93 + 0.07 * sin(time * 7.0 + vUv.y * 12.0);
    col += (rand(puv + fract(time)) - 0.5) * 0.07;

    // per-screen vignette + a brightened "tube" centre
    vec2 d = vUv - 0.5;
    col *= smoothstep(1.15, 0.25, dot(d, d) * 3.0);

    col = clamp(col * 1.12, 0.0, 1.0);
    // approximate sRGB -> linear so it sits right under the tone-mapping pass
    gl_FragColor = vec4(pow(col, vec3(2.2)), 1.0);
  }
`

/* shared value-noise for the "broken reality" debug rooms */
const NOISE_GLSL = /* glsl */ `
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i + vec2(0.0,0.0)), hash(i + vec2(1.0,0.0)), u.x),
               mix(hash(i + vec2(0.0,1.0)), hash(i + vec2(1.0,1.0)), u.x), u.y);
  }
  float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i=0;i<4;i++){ s += a*vnoise(p); p *= 2.0; a *= 0.5; } return s; }
`

// 6 — Reality peel: a grid "wallpaper" flakes off in patches, revealing white
// wireframe + grey placeholder material underneath, with a dark curl at the tear.
const PEEL_FRAG = /* glsl */ `
  precision mediump float;
  varying vec2 vUv;
  uniform float gridScale, peelScale, wireScale, thr;
  ${NOISE_GLSL}
  void main(){
    vec2 uv = vUv;
    // wallpaper: cream paper with blueprint grid lines
    vec2 g = uv * gridScale; vec2 gf = abs(fract(g) - 0.5);
    float minor = smoothstep(0.47, 0.5, max(gf.x, gf.y));
    vec3 paperCol = mix(vec3(0.85,0.83,0.76), vec3(0.46,0.55,0.68), minor);
    // peel mask – where the paper is still attached
    float n = fbm(uv * peelScale);
    float paper = smoothstep(thr - 0.03, thr + 0.06, n);
    // underneath: grey placeholder + white triangle wireframe
    vec2 wg = uv * wireScale; vec2 wf = abs(fract(wg) - 0.5);
    float wl = smoothstep(0.45, 0.5, max(wf.x, wf.y));
    float wd = smoothstep(0.45, 0.5, abs(fract(wg.x + wg.y) - 0.5));
    float wire = max(wl, wd);
    vec3 placeholder = mix(vec3(0.52), vec3(0.97), wire);
    // dark curl shadow right at the tear line
    float curl = smoothstep(0.10, 0.0, abs(n - thr));
    vec3 col = mix(placeholder, paperCol, paper);
    col *= mix(1.0, 0.5, curl);
    gl_FragColor = vec4(pow(col, vec3(2.2)), 1.0);
  }
`

// 7 — Texture not found: patches of neon dev-grid, magenta/black missing-texture
// checker, and real concrete, stitched together by a region mask.
const MISS_FRAG = /* glsl */ `
  precision mediump float;
  varying vec2 vUv;
  uniform sampler2D concrete;
  uniform float regionScale, neonScale, checkScale, concreteScale;
  ${NOISE_GLSL}
  void main(){
    vec2 uv = vUv;
    float r = fbm(uv * regionScale);
    // neon dev grid
    vec2 ng = uv * neonScale; vec2 nf = abs(fract(ng) - 0.5);
    float nl = smoothstep(0.46, 0.5, max(nf.x, nf.y));
    vec3 neon = mix(vec3(0.015,0.03,0.04), vec3(0.15,1.0,0.7), nl);
    // magenta/black missing-texture checker
    vec2 cg = floor(uv * checkScale); float chk = mod(cg.x + cg.y, 2.0);
    vec3 miss = mix(vec3(0.03), vec3(1.0,0.0,1.0), chk);
    // real concrete
    vec3 conc = texture2D(concrete, uv * concreteScale).rgb;
    vec3 col = r < 0.42 ? neon : (r < 0.68 ? miss : conc);
    gl_FragColor = vec4(pow(col, vec3(2.2)), 1.0);
  }
`

// 8 — The Fourth Side: cold near-black floor with a faint TRON cyan grid.
const GRID_FRAG = /* glsl */ `
  precision mediump float;
  varying vec2 vUv;
  uniform float scale;
  void main(){
    vec2 g = vUv * scale; vec2 gf = abs(fract(g) - 0.5);
    float line = smoothstep(0.49, 0.5, max(gf.x, gf.y));
    vec2 g2 = vUv * scale * 4.0; vec2 gf2 = abs(fract(g2) - 0.5);
    float sub = smoothstep(0.48, 0.5, max(gf2.x, gf2.y)) * 0.22;
    vec3 col = vec3(0.008, 0.018, 0.03) + vec3(0.0, 0.82, 1.0) * (line + sub);
    gl_FragColor = vec4(pow(col, vec3(2.2)), 1.0);
  }
`

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
      {/* even, soft ambient so nothing is crushed – no near-floor point lights
          (those were blowing out a hotspot on the left/centre of the floor) */}
      <ambientLight intensity={0.22} color="#f3ead9" />
      {/* cool RIM from behind to separate edges from the floor */}
      <directionalLight position={[7, 6, -11]} intensity={1.1} color="#b9d0ff" />
      {/* high, broad cool fill opposite the key – placed up high so it grades the
          floor smoothly instead of pooling into a bright spot */}
      <pointLight position={[3.5, 13, 5.0]} intensity={34} distance={40} decay={2} color="#bcd0ff" />

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
}: {
  env: EnvConfig
  muted: boolean
  measureMode: boolean
  selectedId: string | null
  setSelectedId: (id: string | null) => void
  registerReset: (fn: () => void) => void
  tiltRef: React.MutableRefObject<TiltState>
  grabbingRef: React.MutableRefObject<boolean>
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
  const puzzleLock = useRef(false) // blocks become impervious during the win celebration
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
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2 && drag.current) {
        startDist = span(e)
        squeeze = 0
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
    }
    const onEnd = (e: TouchEvent) => {
      if (startDist <= 0) return
      if (e.touches.length < 2) {
        const d = drag.current
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

    // current world position + velocity of the grab point
    const t = d.body.translation()
    const r = d.body.rotation()
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w)
    const rWorld = d.localAnchor.clone().applyQuaternion(q) // offset from centre
    const anchor = new THREE.Vector3(t.x, t.y, t.z).add(rWorld)
    const lv = d.body.linvel()
    const av = d.body.angvel()
    const pointVel = new THREE.Vector3(av.x, av.y, av.z).cross(rWorld).add(
      new THREE.Vector3(lv.x, lv.y, lv.z),
    )

    // damped spring (PD), with the error and acceleration both clamped so you
    // can never apply a large force -> the pieces feel heavy and unhurlable
    const err = target.sub(anchor)
    if (err.length() > DRAG_ERR_MAX) err.setLength(DRAG_ERR_MAX)
    const accel = err.multiplyScalar(DRAG_K).addScaledVector(pointVel, -DRAG_C)
    if (accel.length() > DRAG_ACCEL_MAX) accel.setLength(DRAG_ACCEL_MAX)
    const m = d.body.mass() || 1
    d.body.applyImpulseAtPoint(
      { x: accel.x * m * dt, y: accel.y * m * dt, z: accel.z * m * dt },
      { x: anchor.x, y: anchor.y, z: anchor.z },
      true,
    )

    // hard speed caps while held – the dead giveaway of a weighty object
    const lv2 = d.body.linvel()
    const sp = Math.hypot(lv2.x, lv2.y, lv2.z)
    if (sp > MAX_DRAG_SPEED) {
      const k = MAX_DRAG_SPEED / sp
      d.body.setLinvel({ x: lv2.x * k, y: lv2.y * k, z: lv2.z * k }, true)
    }
    const av2 = d.body.angvel()
    const asp = Math.hypot(av2.x, av2.y, av2.z)
    if (asp > MAX_DRAG_ANGSPEED) {
      const k = MAX_DRAG_ANGSPEED / asp
      d.body.setAngvel({ x: av2.x * k, y: av2.y * k, z: av2.z * k }, true)
    }
  })

  /* ---- safety net: rescue any body that ever leaves the box ---- */
  // Belt-and-braces guarantee on top of the solid walls and drag clamp: if a
  // body is ever found outside the tray (a freak tunnel, a stale resize), pull
  // it back inside and kill its velocity instead of letting it vanish offscreen.
  useFrame(() => {
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
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-near={1}
        shadow-camera-far={70}
        shadow-camera-left={-shadowSpan}
        shadow-camera-right={shadowSpan}
        shadow-camera-top={shadowSpan}
        shadow-camera-bottom={-shadowSpan}
        shadow-bias={-0.00015}
        shadow-normalBias={0.025}
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

      <TiltController tiltRef={tiltRef} />

      {/* static world: floor + tall invisible containment walls */}
      <RigidBody type="fixed" colliders={false} friction={0.7} restitution={0.1}>
        <CuboidCollider args={[60, 1, 60]} position={[0, -1, 0]} />
        {colliderWalls.map((w, i) => (
          <CuboidCollider key={i} args={w.half} position={w.pos} restitution={0.12} />
        ))}
      </RigidBody>

      {/* environment-specific room: floor, walls, fill lighting */}
      <Room env={env} box={box} visibleWalls={visibleWalls} shadowSpan={shadowSpan} roughMap={roughMap} muted={muted} />

      {/* reactive floor: tiles flash where blocks strike, brightness ~ force */}
      <ImpactGlows poolRef={glowPool} active={!!env.reactive} tile={GLASS_TILE} />

      {/* klossete sorting puzzle: win detection + Morse lightbulb celebration */}
      {env.puzzle && <PuzzleController bodies={bodies} box={box} lockRef={puzzleLock} />}

      {/* blocks */}
      {BLOCKS.map((b) => (
        <BlockBody
          key={b.id}
          block={b}
          bodyRef={(r) => (bodies.current[b.id] = r)}
          onGrab={onGrab}
          onImpact={onBlockImpact}
          knock={!reactive}
          showAfterimage={env.fourthSide === true}
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
/*  Top-down camera – looks straight down into the box, fits any aspect */
/*  (uses the same boxLayout as the walls, so they always agree).       */
/* ------------------------------------------------------------------ */
function CameraRig() {
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)

  useEffect(() => {
    const aspect = size.width / size.height
    const { dist } = boxLayout(aspect, viewTarget(size.width, size.height))

    const cam = camera as THREE.PerspectiveCamera
    cam.up.set(0, 0, -1) // screen-up maps to -z
    cam.position.set(0, dist, 0)
    cam.lookAt(0, 0, 0)
    cam.fov = CAM_FOV
    cam.aspect = aspect
    cam.updateProjectionMatrix()
  }, [camera, size])

  return null
}

/* ------------------------------------------------------------------ */
/*  Public component                                                   */
/* ------------------------------------------------------------------ */
export default function WoodenBlocks() {
  const [measureMode, setMeasureMode] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tiltOn, setTiltOn] = useState(false)
  const [muted, setMutedState] = useState(false)
  const [envIndex, setEnvIndex] = useState(0)
  const env = ENVIRONMENTS[envIndex] ?? ENVIRONMENTS[0] // never crash on a stale/out-of-range index
  const resetRef = useRef<() => void>(() => {})
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

  // Open on a RANDOM environment each visit. Done in an effect (not in useState)
  // so server + client first render agree – no hydration mismatch.
  useEffect(() => {
    setEnvIndex(Math.floor(Math.random() * ENVIRONMENTS.length))
  }, [])

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

  const toggleTilt = useCallback(async () => {
    if (tiltOn) {
      window.removeEventListener("deviceorientation", onOrient)
      tiltRef.current.enabled = false
      setTiltOn(false)
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

    window.addEventListener("deviceorientation", onOrient)
    tiltRef.current.enabled = true
    setTiltOn(true)
  }, [tiltOn, onOrient])

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
          numSolverIterations={8}
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
            />
          </Suspense>
        </Physics>

        {/* realism pass: ambient occlusion grounds the blocks, a gentle vignette
            adds depth, ACES tone mapping seats the contrast, SMAA cleans edges.
            Bloom is added for the gold + glass environments to make seams glow. */}
        <EffectComposer key={env.id} multisampling={0}>
          <N8AO aoRadius={1.4} intensity={env.id === "glass" ? 1.4 : 2.6} distanceFalloff={1} halfRes color="#1c160e" />
          <Bloom
            intensity={env.id === "gold" ? 0.75 : env.id === "glass" ? 0.3 : 0}
            luminanceThreshold={env.id === "glass" ? 0.9 : 0.55}
            luminanceSmoothing={0.2}
            mipmapBlur
          />
          <Vignette offset={0.32} darkness={env.id === "glass" ? 0.28 : 0.42} />
          <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
          <SMAA />
        </EffectComposer>
      </Canvas>

      {/* UI – auto-hiding control cluster (fades in when the pointer is near).
          pointer-events follow visibility so the faded cluster never blocks the
          canvas in the corner. */}
      <div
        onPointerEnter={revealUI}
        onPointerLeave={scheduleHide}
        style={{ color: env.id === "gold" ? "#efe1c2" : "#262626" }}
        className={`absolute bottom-5 right-5 z-10 flex flex-col gap-3 p-2 transition-opacity duration-700 ease-out ${
          uiShown ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        <button
          type="button"
          aria-label={`Environment: ${env.name} (press 1-${ENVIRONMENTS.length} or two-finger hold)`}
          onClick={() => setEnvIndex((i) => (i + 1) % ENVIRONMENTS.length)}
          className="pointer-events-auto relative flex h-11 w-11 items-center justify-center rounded-full opacity-40 transition hover:opacity-90"
        >
          <Layers className="h-5 w-5" strokeWidth={2.4} />
          <span className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-foreground text-[9px] font-bold text-background">
            {envIndex + 1}
          </span>
        </button>
        <button
          type="button"
          aria-label={muted ? "Unmute impact sounds" : "Mute impact sounds"}
          aria-pressed={muted}
          onClick={() => {
            const next = !muted
            setMutedState(next)
            setMuted(next)
          }}
          className="pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full opacity-40 transition hover:opacity-90"
        >
          {muted ? (
            <VolumeX className="h-5 w-5" strokeWidth={2.4} />
          ) : (
            <Volume2 className="h-5 w-5" strokeWidth={2.4} />
          )}
        </button>
        <button
          type="button"
          aria-label="Tilt to control gravity"
          aria-pressed={tiltOn}
          onClick={toggleTilt}
          className={`pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full transition ${
            tiltOn ? "opacity-100" : "opacity-40 hover:opacity-90"
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
