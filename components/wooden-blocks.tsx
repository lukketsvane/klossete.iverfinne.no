"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Canvas, useThree } from "@react-three/fiber"
import { Environment, RoundedBox, ContactShadows, Html } from "@react-three/drei"
import {
  Physics,
  RigidBody,
  CuboidCollider,
  CylinderCollider,
  type RapierRigidBody,
} from "@react-three/rapier"
import * as THREE from "three"
import { RotateCcw, Ruler } from "lucide-react"

/* ------------------------------------------------------------------ */
/*  Rapier body-type constants (avoid importing the wasm enum)         */
/* ------------------------------------------------------------------ */
const BODY_DYNAMIC = 0
const BODY_KINEMATIC_POSITION = 2

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
    pos: [-5.5, (30 * S) / 2 + REST, -1],
  },
  {
    id: "orange",
    name: "Orange Block",
    color: "#e07b22",
    shape: "box",
    // 45 × 45 × 24, lying so the 24 mm dimension is the height
    half: [(45 * S) / 2, (24 * S) / 2, (45 * S) / 2],
    dims: "45 × 45 × 24 mm",
    pos: [-2.3, (24 * S) / 2 + REST, 2.4],
  },
  {
    id: "plank-long",
    name: "Blue Plank",
    color: "#2f63cc",
    shape: "box",
    // 75 × 30 × 15, lying flat (75 along x, 30 along z, 15 high)
    half: [(75 * S) / 2, (15 * S) / 2, (30 * S) / 2],
    dims: "75 × 30 × 15 mm",
    pos: [1.4, (15 * S) / 2 + REST, 2.6],
  },
  {
    id: "plank-short",
    name: "Blue Short Plank",
    color: "#2f63cc",
    shape: "box",
    // 60 × 30 × 15, lying flat (60 along z, 30 along x, 15 high)
    half: [(30 * S) / 2, (15 * S) / 2, (60 * S) / 2],
    dims: "60 × 30 × 15 mm",
    pos: [0.6, (15 * S) / 2 + REST, -1.6],
  },
  {
    id: "cylinder",
    name: "Red Cylinder",
    color: "#c83a2e",
    shape: "cylinder",
    radius: (30 * S) / 2,
    halfHeight: (60 * S) / 2,
    dims: "Ø 30 mm · H 60 mm",
    pos: [4.6, (60 * S) / 2 + REST, -0.4],
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
/*  Invisible walls fitted to the exact visible floor region           */
/* ------------------------------------------------------------------ */
type Wall = {
  half: [number, number, number]
  pos: [number, number, number]
  rot: [number, number, number]
}

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

    const corners = ndc.map(([x, y]) => {
      const v = new THREE.Vector3(x, y, 0.5).unproject(cam)
      const dir = v.sub(camPos).normalize()
      const t = -camPos.y / dir.y // intersect plane y = 0
      return camPos.clone().add(dir.multiplyScalar(t))
    })

    const centroid = corners
      .reduce((a, c) => a.add(c), new THREE.Vector3())
      .multiplyScalar(1 / corners.length)

    const HEIGHT = 9
    const HALF_THICK = 0.4

    const next: Wall[] = corners.map((a, i) => {
      const b = corners[(i + 1) % corners.length]
      const mid = a.clone().add(b).multiplyScalar(0.5)
      const edge = b.clone().sub(a)
      const len = Math.hypot(edge.x, edge.z)
      const angle = Math.atan2(-edge.z, edge.x)
      const outward = new THREE.Vector3(mid.x - centroid.x, 0, mid.z - centroid.z).normalize()
      const center = mid.clone().add(outward.multiplyScalar(HALF_THICK))
      return {
        half: [len / 2 + HALF_THICK, HEIGHT / 2, HALF_THICK],
        pos: [center.x, HEIGHT / 2, center.z],
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

  const labelY =
    block.shape === "cylinder" ? block.halfHeight + 0.5 : block.half[1] + 0.5

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
            <cylinderGeometry
              args={[block.radius, block.radius, block.halfHeight * 2, 48]}
            />
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
}: {
  measureMode: boolean
  selectedId: string | null
  setSelectedId: (id: string | null) => void
  registerReset: (fn: () => void) => void
}) {
  const { camera, gl, size } = useThree()
  const walls = useFrustumWalls()
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
      {/* lighting */}
      <ambientLight intensity={0.45} />
      <directionalLight
        position={[6, 12, 7]}
        intensity={2.6}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-14}
        shadow-camera-right={14}
        shadow-camera-top={14}
        shadow-camera-bottom={-14}
        shadow-bias={-0.0002}
      />
      <Environment preset="apartment" environmentIntensity={0.35} />

      <ContactShadows
        position={[0, 0.002, 0]}
        scale={40}
        far={6}
        blur={2.4}
        opacity={0.35}
        resolution={1024}
      />

      {/* static world: floor + frustum walls */}
      <RigidBody type="fixed" colliders={false} friction={0.85} restitution={0.08}>
        <CuboidCollider args={[60, 1, 60]} position={[0, -1, 0]} />
        {walls.map((w, i) => (
          <CuboidCollider key={i} args={w.half} position={w.pos} rotation={w.rot} restitution={0.25} />
        ))}
      </RigidBody>

      {/* visible floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[120, 120]} />
        <meshStandardMaterial color="#f3efe7" roughness={0.95} metalness={0} />
      </mesh>

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
        <mesh
          position={[0, -0.5, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
          onPointerDown={() => setSelectedId(null)}
        >
          <planeGeometry args={[200, 200]} />
          <meshBasicMaterial visible={false} />
        </mesh>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ */
/*  Responsive camera – keeps the whole play area framed on any aspect */
/*  (critical for tall iPhone portrait screens where the horizontal    */
/*   field of view is far narrower than on desktop).                   */
/* ------------------------------------------------------------------ */
const CAM_FOV = 34
const CAM_DIR = new THREE.Vector3(0, 20, 16).normalize()
const TARGET_HALF_WIDTH = 7.5 // world units of content to keep visible across
const TARGET_HALF_HEIGHT = 6 // world units to keep visible top-to-bottom

function CameraRig() {
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)

  useEffect(() => {
    const aspect = size.width / size.height
    const halfV = Math.tan((CAM_FOV / 2) * (Math.PI / 180))
    const distForWidth = TARGET_HALF_WIDTH / (halfV * aspect)
    const distForHeight = TARGET_HALF_HEIGHT / halfV
    const dist = Math.max(distForWidth, distForHeight)

    camera.position.copy(CAM_DIR.clone().multiplyScalar(dist))
    camera.lookAt(0, 0, 0)
    ;(camera as THREE.PerspectiveCamera).fov = CAM_FOV
    ;(camera as THREE.PerspectiveCamera).aspect = aspect
    camera.updateProjectionMatrix()
  }, [camera, size])

  return null
}

/* ------------------------------------------------------------------ */
/*  Public component                                                   */
/* ------------------------------------------------------------------ */
export default function WoodenBlocks() {
  const [measureMode, setMeasureMode] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const resetRef = useRef<() => void>(() => {})

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-[#f6f2ea]">
      <Canvas
        shadows
        dpr={[1, 2]}
        gl={{ antialias: true, preserveDrawingBuffer: false }}
        camera={{ position: [0, 20, 16], fov: 34, near: 0.1, far: 200 }}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping
          gl.toneMappingExposure = 1.05
          gl.domElement.style.cursor = "grab"
        }}
        style={{ touchAction: "none" }}
      >
        <color attach="background" args={["#f6f2ea"]} />
        <CameraRig />
        <Physics gravity={[0, -16, 0]} timeStep={1 / 120} interpolate>
          <SceneContents
            measureMode={measureMode}
            selectedId={selectedId}
            setSelectedId={setSelectedId}
            registerReset={(fn) => (resetRef.current = fn)}
          />
        </Physics>
      </Canvas>

      {/* UI */}
      <div className="pointer-events-none absolute bottom-7 right-7 z-10 flex flex-col gap-3">
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
        {measureMode ? "Tap a block to see its size" : "Drag to slide · flick to throw"}
      </p>
    </div>
  )
}
