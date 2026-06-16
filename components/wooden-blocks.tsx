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
const S = 0.07 // 1 mm -> scene units

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
    pos: [-2.3, (30 * S) / 2 + REST, -4.6],
  },
  {
    id: "orange",
    name: "Orange Block",
    color: "#e07b22",
    shape: "box",
    // 45 × 45 × 24, lying so the 24 mm dimension is the height
    half: [(45 * S) / 2, (24 * S) / 2, (45 * S) / 2],
    dims: "45 × 45 × 24 mm",
    pos: [-1.3, (24 * S) / 2 + REST, 0.4],
  },
  {
    id: "plank-long",
    name: "Blue Plank",
    color: "#2f63cc",
    shape: "box",
    // 75 × 30 × 15, lying flat (75 along x, 30 along z, 15 high)
    half: [(75 * S) / 2, (15 * S) / 2, (30 * S) / 2],
    dims: "75 × 30 × 15 mm",
    pos: [0.3, (15 * S) / 2 + REST, 5],
  },
  {
    id: "plank-short",
    name: "Blue Short Plank",
    color: "#2f63cc",
    shape: "box",
    // 60 × 30 × 15, lying flat (60 along z, 30 along x, 15 high)
    half: [(30 * S) / 2, (15 * S) / 2, (60 * S) / 2],
    dims: "60 × 30 × 15 mm",
    pos: [2, (15 * S) / 2 + REST, -2.3],
  },
  {
    id: "cylinder",
    name: "Red Cylinder",
    color: "#c83a2e",
    shape: "cylinder",
    radius: (30 * S) / 2,
    halfHeight: (60 * S) / 2,
    dims: "Ø 30 mm · H 60 mm",
    pos: [1.9, (60 * S) / 2 + REST, 3],
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
/*  Box walls fitted to the visible floor region (inset to form a tray)*/
/* ------------------------------------------------------------------ */
type Wall = {
  half: [number, number, number]
  pos: [number, number, number]
  rot: [number, number, number]
}

const WALL_HEIGHT = 3.2
const WALL_HALF_THICK = 0.4
const BOX_INSET = 0.9 // shrink the box toward centre so the frame reads inside the screen

function useFrustumWalls() {
  const { camera, size } = useThree()
  const [walls, setWalls] = useState<Wall[]>([])

  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera
    cam.updateMatrixWorld()

    const ndc: [number, number][] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]
    const camPos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld)

    const raw = ndc.map(([x, y]) => {
      const v = new THREE.Vector3(x, y, 0.5).unproject(cam)
      const dir = v.sub(camPos).normalize()
      const t = -camPos.y / dir.y // intersect plane y = 0
      return camPos.clone().add(dir.multiplyScalar(t))
    })

    const centroid = raw
      .reduce((a, c) => a.add(c), new THREE.Vector3())
      .multiplyScalar(1 / raw.length)

    // inset the corners toward the centre so all four walls sit inside the view
    const corners = raw.map((c) => centroid.clone().lerp(c, BOX_INSET))

    const next: Wall[] = corners.map((a, i) => {
      const b = corners[(i + 1) % corners.length]
      const mid = a.clone().add(b).multiplyScalar(0.5)
      const edge = b.clone().sub(a)
      const len = Math.hypot(edge.x, edge.z)
      const angle = Math.atan2(-edge.z, edge.x)
      const outward = new THREE.Vector3(mid.x - centroid.x, 0, mid.z - centroid.z).normalize()
      const center = mid.clone().add(outward.multiplyScalar(WALL_HALF_THICK))
      return {
        half: [len / 2 + WALL_HALF_THICK, WALL_HEIGHT / 2, WALL_HALF_THICK],
        pos: [center.x, WALL_HEIGHT / 2, center.z],
        rot: [0, angle, 0],
      }
    })

    setWalls(next)
  }, [camera, size.width, size.height])

  return walls
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
  onGrab: (body: RapierRigidBody, point: THREE.Vector3) => void
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
    onGrab(ref.current, e.point.clone())
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
      friction={0.85}
      restitution={0.04}
      density={3}
      linearDamping={0.35}
      angularDamping={0.55}
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
const G = 18

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
}

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
  const walls = useFrustumWalls()
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
    (body: RapierRigidBody, point: THREE.Vector3) => {
      gl.domElement.style.cursor = "grabbing"
      const t = body.translation()
      const center = new THREE.Vector3(t.x, t.y, t.z)
      const liftY = Math.max(point.y, 0.4)
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
      const max = 14
      if (v.length() > max) v.setLength(max)
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

      {/* static world: floor + box walls (colliders) */}
      <RigidBody type="fixed" colliders={false} friction={0.85} restitution={0.08}>
        <CuboidCollider args={[60, 1, 60]} position={[0, -1, 0]} />
        {walls.map((w, i) => (
          <CuboidCollider key={i} args={w.half} position={w.pos} rotation={w.rot} restitution={0.2} />
        ))}
      </RigidBody>

      {/* visible floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[120, 120]} />
        <meshStandardMaterial color="#f1ece2" roughness={0.95} metalness={0} />
      </mesh>

      {/* visible box walls */}
      {walls.map((w, i) => (
        <mesh key={`wall-${i}`} position={w.pos} rotation={w.rot} castShadow receiveShadow>
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
/* ------------------------------------------------------------------ */
const CAM_FOV = 36
const TARGET_HALF_X = 4.4 // world units to keep visible across the short axis
const TARGET_HALF_Z = 4.4 // world units to keep visible across the long axis

function CameraRig() {
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)

  useEffect(() => {
    const aspect = size.width / size.height
    const halfV = Math.tan((CAM_FOV / 2) * (Math.PI / 180))
    const distForX = TARGET_HALF_X / (halfV * aspect)
    const distForZ = TARGET_HALF_Z / halfV
    const dist = Math.max(distForX, distForZ) + 0.5

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
        <Physics gravity={[0, -G, 0]} timeStep={1 / 120} interpolate>
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
