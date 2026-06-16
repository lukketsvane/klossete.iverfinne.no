"use client"

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Canvas, useThree, useFrame } from "@react-three/fiber"
import { ContactShadows, Html, useGLTF } from "@react-three/drei"
import { EffectComposer, N8AO, SMAA, ToneMapping, Vignette } from "@react-three/postprocessing"
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
import { RotateCcw, Ruler, Smartphone, Volume2, VolumeX } from "lucide-react"
import { playImpact, primeBlocks, setMuted, unlockAudio } from "@/lib/impact-sound"

/* ------------------------------------------------------------------ */
/*  Rapier body-type constants (avoid importing the wasm enum)         */
/* ------------------------------------------------------------------ */
const BODY_DYNAMIC = 0

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
const TARGET_HALF_X = 4.4 // world units to keep visible across the short axis
const TARGET_HALF_Z = 4.4 // world units to keep visible across the long axis
const BOX_INSET = 0.9 // pull the walls inward so the whole frame reads on screen
const WALL_HALF_THICK = 0.4
const WALL_VIS_HEIGHT = 3.0 // the wood-coloured tray walls you actually see
const WALL_COL_HEIGHT = 16 // invisible containment walls – a deep box nothing escapes

// Half extents of the inner wall faces: the playable rectangle on the floor.
type Box = { bx: number; bz: number }

function boxLayout(aspect: number) {
  const halfV = Math.tan((CAM_FOV / 2) * (Math.PI / 180))
  const dist = Math.max(TARGET_HALF_X / (halfV * aspect), TARGET_HALF_Z / halfV) + 0.5
  const halfX = dist * halfV * aspect
  const halfZ = dist * halfV
  return { dist, bx: halfX * BOX_INSET, bz: halfZ * BOX_INSET }
}

function useBox(): Box {
  const size = useThree((s) => s.size)
  return useMemo(() => {
    const { bx, bz } = boxLayout(size.width / size.height)
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
  measureMode,
  selected,
  onSelect,
}: {
  block: Block
  bodyRef: (b: RapierRigidBody | null) => void
  onGrab: (body: RapierRigidBody, point: THREE.Vector3, block: Block) => void
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
    if (strength > 0) playImpact(block.id, strength)
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
      friction={0.6}
      restitution={0.16}
      density={6}
      linearDamping={0.08}
      angularDamping={0.4}
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
// Stronger-than-default gravity so the now-smaller blocks read as heavy solid
// wood that drops and settles quickly instead of drifting down.
const G = 28

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
  liftY: number
  radius: number // horizontal footprint, used to keep the block off the walls
}

const MIN_LIFT = 0.55 // how high the grab point floats while you slide it
const MAX_LIFT = WALL_VIS_HEIGHT - 0.6 // never lift above the tray rim
const THROW_MAX = 3.4 // hard clamp on release speed – a gentle set-down, never a fling
const ESCAPE_MARGIN = 0.4 // how far past a wall a body must be before we rescue it

/* Soft "grab spring": the block is held by the exact point you grabbed, via a
   damped spring (PD controller) applied at that point. Because the pull acts at
   the grab point while gravity pulls the centre of mass, the piece hangs and
   swings from your cursor like it's on a string. Force and speed are clamped
   low, so the blocks always feel heavy and can never be hurled. */
const DRAG_K = 150 // spring stiffness (how eagerly the grab point chases the cursor)
const DRAG_C = 25 // damping (~critical, kills wobble)
const DRAG_ERR_MAX = 1.1 // cap on position error -> caps the pull force
const DRAG_ACCEL_MAX = 130 // hard ceiling on grab acceleration -> can't yank hard
const MAX_DRAG_SPEED = 4.5 // linear speed cap while held
const MAX_DRAG_ANGSPEED = 7 // spin cap while held
const LIGHT_RADIUS = 14 // how far the key light orbits when you shift+right-drag it

function SceneContents({
  measureMode,
  selectedId,
  setSelectedId,
  registerReset,
  tiltRef,
}: {
  measureMode: boolean
  selectedId: string | null
  setSelectedId: (id: string | null) => void
  registerReset: (fn: () => void) => void
  tiltRef: React.MutableRefObject<TiltState>
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
  const lightDragging = useRef(false)
  const pointerNdc = useRef(new THREE.Vector2())
  const raycaster = useMemo(() => new THREE.Raycaster(), [])

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
      gl.domElement.style.cursor = "grabbing"
      const t = body.translation()
      const r = body.rotation()
      const center = new THREE.Vector3(t.x, t.y, t.z)
      const q = new THREE.Quaternion(r.x, r.y, r.z, r.w)
      // grab point expressed relative to the body centre, in body-local space,
      // so we can track exactly where it has swung to each frame
      const localAnchor = point.clone().sub(center).applyQuaternion(q.clone().invert())
      const liftY = THREE.MathUtils.clamp(point.y, MIN_LIFT, MAX_LIFT)
      body.wakeUp()
      body.setLinvel({ x: 0, y: 0, z: 0 }, true)
      body.setAngvel({ x: 0, y: 0, z: 0 }, true)
      drag.current = {
        body,
        block,
        plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), -liftY),
        localAnchor,
        liftY,
        radius: blockRadius(block),
      }
    },
    [gl],
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
      // gentle set-down: the body is already moving slowly (speed was capped
      // while held); clamp once more so a release can never become a fling
      const lv = d.body.linvel()
      const v = new THREE.Vector3(lv.x, lv.y, lv.z)
      if (v.length() > THROW_MAX) {
        v.setLength(THROW_MAX)
        d.body.setLinvel({ x: v.x, y: v.y, z: v.z }, true)
      }
      drag.current = null
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
      {/* ----- motivated lighting rig (no HDRI / no broad fill) ----- */}

      {/* Soft warm KEY – the only shadow caster, read as an overhead practical. */}
      <directionalLight
        ref={lightRef}
        position={[KEY.x, KEY.y, KEY.z]}
        intensity={3.1}
        color="#fff1df"
        castShadow
        shadow-mapSize-width={4096}
        shadow-mapSize-height={4096}
        shadow-camera-near={1}
        shadow-camera-far={70}
        shadow-camera-left={-shadowSpan}
        shadow-camera-right={shadowSpan}
        shadow-camera-top={shadowSpan}
        shadow-camera-bottom={-shadowSpan}
        shadow-bias={-0.00015}
        shadow-normalBias={0.025}
      />

      {/* Cool RIM / kicker from behind, grazing, to separate edges from floor. */}
      <directionalLight position={[7, 6, -11]} intensity={1.25} color="#b9d0ff" />

      {/* Warm PRACTICAL: a nearby lamp pool with physical inverse-square falloff. */}
      <pointLight position={[-3.4, 3.0, -1.2]} intensity={26} distance={14} decay={2} color="#ffce92" />

      {/* Cool motivated FILL opposite the key – localized (not a broad ambient);
          the far side is intentionally left darker for negative-fill contrast. */}
      <pointLight position={[5.6, 9, 6.5]} intensity={44} distance={26} decay={2} color="#a6beff" />

      {/* Faint floor BOUNCE lifting the block undersides. */}
      <pointLight position={[0, 0.7, 0]} intensity={7} distance={9} decay={2} color="#ffe7c4" />

      {/* soft contact shadow that grounds the blocks; sized to the box so it
          fills any screen and stays crisp instead of spread thin */}
      <ContactShadows
        position={[0, 0.001, 0]}
        scale={shadowSpan * 2}
        resolution={2048}
        far={4}
        blur={2.2}
        opacity={0.5}
        color="#332b20"
      />

      <TiltController tiltRef={tiltRef} />

      {/* static world: floor + tall invisible containment walls */}
      <RigidBody type="fixed" colliders={false} friction={0.6} restitution={0.12}>
        <CuboidCollider args={[60, 1, 60]} position={[0, -1, 0]} />
        {colliderWalls.map((w, i) => (
          <CuboidCollider key={i} args={w.half} position={w.pos} restitution={0.15} />
        ))}
      </RigidBody>

      {/* visible floor – matte table surface with a touch of sheen + grain */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[120, 120]} />
        <meshPhysicalMaterial
          color="#efe9dd"
          roughness={0.92}
          roughnessMap={roughMap}
          metalness={0}
          sheen={0.2}
          sheenRoughness={0.9}
          sheenColor="#cfc6b4"
        />
      </mesh>

      {/* visible (short) tray walls */}
      {visibleWalls.map((w, i) => (
        <mesh key={`wall-${i}`} position={w.pos} castShadow receiveShadow>
          <boxGeometry args={[w.half[0] * 2, w.half[1] * 2, w.half[2] * 2]} />
          <meshStandardMaterial color="#d8cfbd" roughness={0.85} roughnessMap={roughMap} metalness={0} />
        </mesh>
      ))}

      {/* blocks */}
      {BLOCKS.map((b) => (
        <BlockBody
          key={b.id}
          block={b}
          bodyRef={(r) => (bodies.current[b.id] = r)}
          onGrab={onGrab}
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
    const { dist } = boxLayout(aspect)

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
  const resetRef = useRef<() => void>(() => {})
  const tiltRef = useRef<TiltState>({ enabled: false, beta: 0, gamma: 0, sx: 0, sz: 0 })
  const iconRef = useRef<HTMLSpanElement>(null)

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

  // Browsers only let audio start from a user gesture – unlock and pre-render
  // each block's impact sound on the first touch.
  useEffect(() => {
    const unlock = () => {
      unlockAudio()
      primeBlocks(BLOCKS.map((b) => ({ id: b.id, freq: blockBaseFreq(b) })))
    }
    window.addEventListener("pointerdown", unlock, { once: true })
    return () => window.removeEventListener("pointerdown", unlock)
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
    <div className="relative h-dvh w-full overflow-hidden bg-[#f6f2ea]">
      <Canvas
        shadows
        dpr={[1, 2]}
        gl={{ antialias: true, preserveDrawingBuffer: false }}
        camera={{ position: [0, 30, 0], fov: CAM_FOV, near: 0.1, far: 200 }}
        onCreated={({ gl }) => {
          // tone mapping is handled by the post-processing ToneMapping effect
          gl.toneMapping = THREE.NoToneMapping
          gl.domElement.style.cursor = "grab"
        }}
        style={{ touchAction: "none" }}
      >
        <color attach="background" args={["#f6f2ea"]} />
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
              measureMode={measureMode}
              selectedId={selectedId}
              setSelectedId={setSelectedId}
              registerReset={(fn) => (resetRef.current = fn)}
              tiltRef={tiltRef}
            />
          </Suspense>
        </Physics>

        {/* realism pass: ambient occlusion grounds the blocks, a gentle vignette
            adds depth, ACES tone mapping seats the contrast, SMAA cleans edges */}
        <EffectComposer multisampling={0}>
          <N8AO aoRadius={1.4} intensity={2.6} distanceFalloff={1} halfRes color="#1c160e" />
          <Vignette offset={0.32} darkness={0.42} />
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
        className={`absolute bottom-5 right-5 z-10 flex flex-col gap-3 p-2 transition-opacity duration-700 ease-out ${
          uiShown ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        <button
          type="button"
          aria-label={muted ? "Unmute impact sounds" : "Mute impact sounds"}
          aria-pressed={muted}
          onClick={() => {
            const next = !muted
            setMutedState(next)
            setMuted(next)
          }}
          className="pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full text-foreground opacity-40 transition hover:opacity-90"
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
          className={`pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full text-foreground transition ${
            tiltOn ? "opacity-100" : "opacity-40 hover:opacity-90"
          }`}
        >
          <span ref={iconRef} className="flex items-center justify-center [transform-style:preserve-3d]">
            <Smartphone className="h-5 w-5" strokeWidth={2.4} />
          </span>
        </button>
        <button
          type="button"
          aria-label="Measure"
          aria-pressed={measureMode}
          onClick={() => {
            setMeasureMode((m) => !m)
            setSelectedId(null)
          }}
          className={`pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full transition ${
            measureMode
              ? "bg-foreground text-background opacity-100 shadow-md"
              : "text-foreground opacity-40 hover:opacity-90"
          }`}
        >
          <Ruler className="h-5 w-5" strokeWidth={2.4} />
        </button>
        <button
          type="button"
          aria-label="Reset blocks"
          onClick={() => {
            setSelectedId(null)
            resetRef.current()
          }}
          className="pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full text-foreground opacity-40 transition hover:opacity-90"
        >
          <RotateCcw className="h-5 w-5" strokeWidth={2.4} />
        </button>
      </div>

    </div>
  )
}
