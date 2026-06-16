"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Canvas, useThree, useFrame } from "@react-three/fiber"
import { ContactShadows, Html, RoundedBox, SoftShadows } from "@react-three/drei"
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

type BoxBlock = {
  id: string
  name: string
  color: string
  shape: "box"
  half: [number, number, number]
  dims: string
  pos: [number, number, number]
  rot?: [number, number, number]
}
type CylBlock = {
  id: string
  name: string
  color: string
  shape: "cylinder"
  radius: number
  halfHeight: number
  dims: string
  pos: [number, number, number]
  rot?: [number, number, number]
}
type Block = BoxBlock | CylBlock

const REST = 0.06 // small gap above floor when spawning

const BLOCKS: Block[] = [
  {
    id: "cube",
    name: "Light-Blue Cube",
    color: "#3f9ec9",
    shape: "box",
    half: [(30 * S) / 2, (30 * S) / 2, (30 * S) / 2],
    dims: "30 × 30 × 30 mm",
    pos: [-1.48, (30 * S) / 2 + REST, -2.96],
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
  },
  {
    id: "plank-long",
    name: "Blue Plank",
    color: "#2f63cc",
    shape: "box",
    // 75 × 30 × 15, lying flat (75 along x, 30 along z, 15 high)
    half: [(75 * S) / 2, (15 * S) / 2, (30 * S) / 2],
    dims: "75 × 30 × 15 mm",
    pos: [0.19, (15 * S) / 2 + REST, 3.21],
  },
  {
    id: "plank-short",
    name: "Blue Short Plank",
    color: "#2f63cc",
    shape: "box",
    // 60 × 30 × 15, lying flat (60 along z, 30 along x, 15 high)
    half: [(30 * S) / 2, (15 * S) / 2, (60 * S) / 2],
    dims: "60 × 30 × 15 mm",
    pos: [1.29, (15 * S) / 2 + REST, -1.48],
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
  },
]

const WOOD = {
  roughness: 0.62,
  metalness: 0.0,
  clearcoat: 0.12,
  clearcoatRoughness: 0.5,
  sheen: 0.25,
}

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
      linearDamping={0.05}
      angularDamping={0.18}
      canSleep={false}
      onCollisionEnter={handleImpact}
      ccd
    >
      {block.shape === "box" ? (
        <>
          <CuboidCollider args={block.half} />
          <RoundedBox
            args={[block.half[0] * 2, block.half[1] * 2, block.half[2] * 2]}
            radius={Math.min(...block.half) * 0.12}
            smoothness={4}
            castShadow
            receiveShadow
            onPointerDown={handlePointerDown}
          >
            <meshPhysicalMaterial color={block.color} {...WOOD} />
          </RoundedBox>
        </>
      ) : (
        <>
          <CylinderCollider args={[block.halfHeight, block.radius]} />
          <mesh castShadow receiveShadow onPointerDown={handlePointerDown}>
            <cylinderGeometry args={[block.radius, block.radius, block.halfHeight * 2, 48]} />
            <meshPhysicalMaterial color={block.color} {...WOOD} />
          </mesh>
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

// Resting position of the warm key light (the tilt controller swings it around
// this anchor as the device tilts).
const KEY = { x: -7, y: 18, z: 8 }

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
  lightRef,
}: {
  tiltRef: React.MutableRefObject<TiltState>
  lightRef: React.MutableRefObject<THREE.DirectionalLight | null>
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

    // the key light swings with the tilt so highlights + shadows shift live
    if (lightRef.current) {
      lightRef.current.position.set(KEY.x + sRight * 8, KEY.y, KEY.z + sDown * 8)
    }
  })

  return null
}

/* ------------------------------------------------------------------ */
/*  Scene contents (inside Canvas) – owns drag controller + walls      */
/* ------------------------------------------------------------------ */
type DragState = {
  body: RapierRigidBody
  plane: THREE.Plane
  offset: THREE.Vector3
  last: THREE.Vector3
  vel: THREE.Vector3
  time: number
  radius: number // horizontal footprint, used to keep the block off the walls
}

const MIN_LIFT = 0.35 // how high a grabbed block floats while you slide it
const MAX_LIFT = WALL_VIS_HEIGHT - 0.6 // never lift above the tray rim
const THROW_MAX = 13 // clamp toss speed for a believable flick
const ESCAPE_MARGIN = 0.4 // how far past a wall a body must be before we rescue it

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
  const bodies = useRef<Record<string, RapierRigidBody | null>>({})
  const drag = useRef<DragState | null>(null)
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
  const onGrab = useCallback(
    (body: RapierRigidBody, point: THREE.Vector3, block: Block) => {
      gl.domElement.style.cursor = "grabbing"
      const t = body.translation()
      const center = new THREE.Vector3(t.x, t.y, t.z)
      const liftY = THREE.MathUtils.clamp(point.y, MIN_LIFT, MAX_LIFT)
      body.setBodyType(BODY_KINEMATIC_POSITION, true)
      body.setLinvel({ x: 0, y: 0, z: 0 }, true)
      body.setAngvel({ x: 0, y: 0, z: 0 }, true)
      drag.current = {
        body,
        plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), -liftY),
        offset: center.sub(point),
        last: new THREE.Vector3(point.x, liftY, point.z),
        vel: new THREE.Vector3(),
        time: performance.now(),
        radius: blockRadius(block),
      }
    },
    [gl],
  )

  /* ---- pointer move / up on the canvas ---- */
  useEffect(() => {
    const el = gl.domElement
    const ndc = new THREE.Vector2()

    const setNdc = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect()
      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
    }

    const onMove = (e: PointerEvent) => {
      const d = drag.current
      if (!d) return
      setNdc(e)
      raycaster.setFromCamera(ndc, camera)
      const hit = new THREE.Vector3()
      if (!raycaster.ray.intersectPlane(d.plane, hit)) return
      const target = hit.add(d.offset)
      target.y = -d.plane.constant // keep at lift height
      // hard-clamp inside the tray so a drag can never pull a block through a
      // wall, accounting for the block's own footprint
      const { bx, bz } = boxRef.current
      const lx = Math.max(bx - d.radius, 0)
      const lz = Math.max(bz - d.radius, 0)
      target.x = THREE.MathUtils.clamp(target.x, -lx, lx)
      target.z = THREE.MathUtils.clamp(target.z, -lz, lz)
      const now = performance.now()
      const dt = Math.max((now - d.time) / 1000, 1 / 240)
      d.vel.copy(target).sub(d.last).multiplyScalar(1 / dt)
      d.last.copy(target)
      d.time = now
      d.body.setNextKinematicTranslation({ x: target.x, y: target.y, z: target.z })
    }

    const onUp = () => {
      const d = drag.current
      if (!d) return
      el.style.cursor = "grab"
      d.body.setBodyType(BODY_DYNAMIC, true)
      // clamp throw speed for a believable toss
      const v = d.vel.clone()
      if (v.length() > THROW_MAX) v.setLength(THROW_MAX)
      d.body.setLinvel({ x: v.x, y: v.y, z: v.z }, true)
      d.body.setAngvel(
        { x: (Math.random() - 0.5) * 3, y: (Math.random() - 0.5) * 3, z: (Math.random() - 0.5) * 3 },
        true,
      )
      drag.current = null
    }

    el.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onUp)
    return () => {
      el.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onUp)
    }
  }, [camera, gl, raycaster, size.width, size.height])

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
      {/* PCSS so the key shadow softens with distance like a real area source */}
      <SoftShadows size={26} samples={16} focus={0.85} />

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

      <TiltController tiltRef={tiltRef} lightRef={lightRef} />

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
          <SceneContents
            measureMode={measureMode}
            selectedId={selectedId}
            setSelectedId={setSelectedId}
            registerReset={(fn) => (resetRef.current = fn)}
            tiltRef={tiltRef}
          />
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

      {/* UI */}
      <div className="pointer-events-none absolute bottom-7 right-7 z-10 flex flex-col gap-3">
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

      <p className="pointer-events-none absolute left-1/2 top-6 z-10 -translate-x-1/2 text-balance text-center text-xs font-medium text-foreground/45">
        {measureMode
          ? "Tap a block to see its size"
          : tiltOn
            ? "Tilt your phone to pour the blocks"
            : "Drag to slide · flick to throw · tap the phone icon to tilt"}
      </p>
    </div>
  )
}
