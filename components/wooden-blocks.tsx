"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Canvas, useThree, useFrame } from "@react-three/fiber"
import { Environment, RoundedBox, ContactShadows, Html } from "@react-three/drei"
import {
  Physics,
  RigidBody,
  CuboidCollider,
  CylinderCollider,
  useRapier,
  type RapierRigidBody,
} from "@react-three/rapier"
import * as THREE from "three"
import { RotateCcw, Ruler, Smartphone } from "lucide-react"

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

function TiltController({
  tiltRef,
  lightRef,
}: {
  tiltRef: React.MutableRefObject<TiltState>
  lightRef: React.MutableRefObject<THREE.DirectionalLight | null>
}) {
  const { world } = useRapier()
  const cur = useRef({ beta: 0, gamma: 0 })

  useFrame(() => {
    const t = tiltRef.current
    const targetBeta = t.enabled ? t.beta : 0
    const targetGamma = t.enabled ? t.gamma : 0

    // smooth toward the target so motion feels like weight settling, not jitter
    cur.current.beta += (targetBeta - cur.current.beta) * 0.12
    cur.current.gamma += (targetGamma - cur.current.gamma) * 0.12

    const b = THREE.MathUtils.clamp(cur.current.beta, -55, 55) * (Math.PI / 180)
    const g = THREE.MathUtils.clamp(cur.current.gamma, -55, 55) * (Math.PI / 180)

    // gravity tilts with the device: lateral component pours the blocks downhill
    const gx = Math.sin(g)
    const gz = Math.sin(b)
    const gy = -Math.max(Math.cos(b) * Math.cos(g), 0.15)
    const v = new THREE.Vector3(gx, gy, gz).normalize().multiplyScalar(G)

    if (world) {
      world.gravity.x = v.x
      world.gravity.y = v.y
      world.gravity.z = v.z
    }

    // the key light swings with the tilt so highlights + shadows shift live
    if (lightRef.current) {
      lightRef.current.position.set(2 + gx * 8, 18, 3 + gz * 8)
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
  const lightRef = useRef<THREE.DirectionalLight>(null)
  const bodies = useRef<Record<string, RapierRigidBody | null>>({})
  const drag = useRef<DragState | null>(null)
  const raycaster = useMemo(() => new THREE.Raycaster(), [])

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
      {/* lighting – mostly overhead so the box reads cleanly from above */}
      <ambientLight intensity={0.55} />
      <directionalLight
        ref={lightRef}
        position={[2, 18, 3]}
        intensity={2.5}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-16}
        shadow-camera-right={16}
        shadow-camera-top={16}
        shadow-camera-bottom={-16}
        shadow-bias={-0.0002}
      />
      <Environment preset="apartment" environmentIntensity={0.35} />

      <ContactShadows position={[0, 0.002, 0]} scale={40} far={6} blur={2.4} opacity={0.3} resolution={1024} />

      <TiltController tiltRef={tiltRef} lightRef={lightRef} />

      {/* static world: floor + tall invisible containment walls */}
      <RigidBody type="fixed" colliders={false} friction={0.6} restitution={0.12}>
        <CuboidCollider args={[60, 1, 60]} position={[0, -1, 0]} />
        {colliderWalls.map((w, i) => (
          <CuboidCollider key={i} args={w.half} position={w.pos} restitution={0.15} />
        ))}
      </RigidBody>

      {/* visible floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[120, 120]} />
        <meshStandardMaterial color="#f1ece2" roughness={0.95} metalness={0} />
      </mesh>

      {/* visible (short) tray walls */}
      {visibleWalls.map((w, i) => (
        <mesh key={`wall-${i}`} position={w.pos} castShadow receiveShadow>
          <boxGeometry args={[w.half[0] * 2, w.half[1] * 2, w.half[2] * 2]} />
          <meshStandardMaterial color="#d8cfbd" roughness={0.9} metalness={0} />
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
  const resetRef = useRef<() => void>(() => {})
  const tiltRef = useRef<TiltState>({ enabled: false, beta: 0, gamma: 0 })

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
          gl.toneMapping = THREE.ACESFilmicToneMapping
          gl.toneMappingExposure = 1.05
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
      </Canvas>

      {/* UI */}
      <div className="pointer-events-none absolute bottom-7 right-7 z-10 flex flex-col gap-3">
        <button
          type="button"
          aria-label="Tilt to control gravity"
          aria-pressed={tiltOn}
          onClick={toggleTilt}
          className={`pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full transition ${
            tiltOn
              ? "bg-foreground text-background opacity-100 shadow-md"
              : "text-foreground opacity-40 hover:opacity-90"
          }`}
        >
          <Smartphone className="h-5 w-5" strokeWidth={2.4} />
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
