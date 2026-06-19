"use client"

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { Canvas, useFrame, useThree } from "@react-three/fiber"
import { useGLTF } from "@react-three/drei"
import { Physics, RigidBody, BallCollider, type RapierRigidBody } from "@react-three/rapier"
import * as THREE from "three"
import { Pause, Play, RotateCcw, Home } from "lucide-react"
import { PostFx } from "@/components/engine/PostFx"
import { buildTrack, type Track } from "@/components/racing/track"

// Warm haze that swallows everything past the near scenery — it sets the mood
// and conveniently hides the "world" beyond the track the reference ignores.
const HAZE = "#d9d3c7"
// The player is the very same red cylinder block used in the puzzle levels.
const CAN_GLB = "/block_red_cylinder.glb"
const CAN_GLB_R = 0.675 // the block's native cylinder radius before scaling
const CAN_R = 0.95 // rolling radius we want on the track (physics + roll)
const CAN_SCALE = CAN_R / CAN_GLB_R
const MAX_SPEED = 27
const STEER = 24 // lateral acceleration from a full left/right input
const CAM_BACK = 9 // how far behind the can the camera sits
const CAM_UP = 3.3 // how far above
const UP3 = new THREE.Vector3(0, 1, 0)

type Phase = "ready" | "run" | "paused" | "finish"

// Shared mutable channel between the DOM HUD and the in-canvas sim, so the
// per-frame loop can drive the readout without re-rendering React every frame.
type Hud = {
  progEl: HTMLSpanElement | null
}

export default function GrandPrix() {
  const track = useMemo(() => buildTrack(7), [])
  const [phase, setPhase] = useState<Phase>("ready")
  const [runId, setRunId] = useState(0)
  const [result, setResult] = useState<{ time: number }>({ time: 0 })
  const [tiltOk, setTiltOk] = useState(false) // device tilt is the live steering source

  const steerRef = useRef(0) // -1 (left) .. 1 (right)
  const phaseRef = useRef<Phase>("ready")
  phaseRef.current = phase
  const hud = useRef<Hud>({ progEl: null }).current
  const containerRef = useRef<HTMLDivElement>(null)

  const running = phase === "run"

  // Tilt steering. The phone's left/right roll (gamma) drives the can; the first
  // reading after enabling becomes the neutral "hold flat" baseline so however
  // you're holding it reads as straight. Touch/keys remain as a fallback when no
  // motion sensor is present (desktop, the CI smoke test).
  const tiltBase = useRef<number | null>(null)
  const tiltListening = useRef(false)
  const enableTilt = useCallback(async () => {
    if (tiltListening.current) return
    const DOE = (typeof window !== "undefined" ? (window as any).DeviceOrientationEvent : null) as any
    if (!DOE) return
    try {
      if (typeof DOE.requestPermission === "function") {
        const res = await DOE.requestPermission()
        if (res !== "granted") return
      }
    } catch {
      return
    }
    tiltListening.current = true
    tiltBase.current = null
    const onTilt = (e: DeviceOrientationEvent) => {
      const g = e.gamma // left/right roll in degrees
      if (g == null) return // a device with no real sensor never sends this
      if (tiltBase.current == null) tiltBase.current = g
      steerRef.current = THREE.MathUtils.clamp((g - tiltBase.current) / 22, -1, 1)
      // only hand steering to tilt once a real reading lands, so desktop keeps
      // its pointer/keyboard fallback
      setTiltOk(true)
    }
    window.addEventListener("deviceorientation", onTilt)
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let down = false
    const start = () => {
      if (phaseRef.current === "ready") setPhase("run")
      // the start gesture is the user gesture iOS needs to grant sensor access
      if (!tiltOk) void enableTilt()
    }
    // Pointer fallback: thumb position relative to centre gives an analog value.
    const applyPointer = (clientX: number) => {
      if (tiltOk) return // tilt owns steering once it's live
      const rect = el.getBoundingClientRect()
      steerRef.current = THREE.MathUtils.clamp(((clientX - rect.left) / rect.width - 0.5) / 0.32, -1, 1)
    }
    const onDown = (e: PointerEvent) => {
      down = true
      start()
      applyPointer(e.clientX)
    }
    const onMove = (e: PointerEvent) => down && applyPointer(e.clientX)
    const onUp = () => {
      down = false
      if (!tiltOk) steerRef.current = 0
    }
    // Keyboard fallback. Track which arrow keys are held so releasing one falls
    // back to the other.
    const held = { left: false, right: false }
    const sync = () => {
      if (!tiltOk) steerRef.current = held.left === held.right ? 0 : held.left ? -1 : 1
    }
    const kd = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" || e.key === "a") held.left = true
      else if (e.key === "ArrowRight" || e.key === "d") held.right = true
      else return
      start()
      sync()
    }
    const ku = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" || e.key === "a") held.left = false
      else if (e.key === "ArrowRight" || e.key === "d") held.right = false
      else return
      sync()
    }

    el.addEventListener("pointerdown", onDown)
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("keydown", kd)
    window.addEventListener("keyup", ku)
    return () => {
      el.removeEventListener("pointerdown", onDown)
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("keydown", kd)
      window.removeEventListener("keyup", ku)
    }
  }, [enableTilt, tiltOk])

  const restart = () => {
    steerRef.current = 0
    tiltBase.current = null
    setResult({ time: 0 })
    if (hud.progEl) hud.progEl.textContent = "0%"
    setRunId((n) => n + 1)
    setPhase("run")
  }
  const onFinish = useCallback((time: number) => {
    setResult({ time })
    setPhase("finish")
  }, [])

  return (
    <div
      ref={containerRef}
      className="relative h-dvh w-full touch-none select-none overflow-hidden"
      style={{ background: HAZE }}
    >
      <Canvas
        key={runId}
        shadows
        dpr={[1, 1.75]}
        gl={{ antialias: true, powerPreference: "high-performance" }}
        camera={{ position: [0, 6, 10], fov: 58, near: 0.3, far: 240 }}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.NoToneMapping
        }}
      >
        <color attach="background" args={[HAZE]} />
        <fog attach="fog" args={[HAZE, 26, 120]} />
        <Physics gravity={[0, -16, 0]} timeStep={1 / 60} maxCcdSubsteps={4} interpolate paused={!running}>
          <Suspense fallback={null}>
            <Scene track={track} steerRef={steerRef} phaseRef={phaseRef} hud={hud} onFinish={onFinish} />
          </Suspense>
        </Physics>
        <PostFx envId="race" />
      </Canvas>

      {/* ---- HUD -------------------------------------------------------- */}
      <div className="pointer-events-none absolute inset-0 z-10">
        {/* pause */}
        {phase !== "finish" && (
          <button
            type="button"
            aria-label={running ? "Pause" : "Spel"}
            onClick={() => setPhase(running ? "paused" : "run")}
            className="pointer-events-auto absolute left-4 top-4 flex h-11 w-11 items-center justify-center rounded-full bg-white/65 text-[#473f33] shadow-sm backdrop-blur-sm transition active:scale-90"
          >
            {running ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
          </button>
        )}

        {/* progress */}
        <div className="absolute right-4 top-4 font-klossete text-lg text-[#473f33]">
          <span
            data-testid="gp-progress"
            className="rounded-full bg-white/65 px-3 py-1 shadow-sm backdrop-blur-sm"
            ref={(el) => { hud.progEl = el }}
          >
            0%
          </span>
        </div>

        {/* decorative sparkle, as in the reference */}
        <span className="absolute bottom-5 right-5 text-2xl text-white/80 drop-shadow">✦</span>

        {/* ready prompt */}
        {phase === "ready" && (
          <div className="absolute inset-x-0 bottom-24 flex flex-col items-center gap-1 text-center font-klossete text-[#473f33]">
            <p className="text-2xl">klossete grand prix</p>
            <p className="rounded-full bg-white/60 px-4 py-1.5 text-base backdrop-blur-sm">
              {tiltOk ? "vipp telefonen for å styre" : "trykk for å starte — vipp for å styre"}
            </p>
          </div>
        )}
      </div>

      {/* pause / finish overlays */}
      {(phase === "paused" || phase === "finish") && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#26262655] px-6 backdrop-blur-sm">
          <div className="flex w-full max-w-xs flex-col items-center gap-4 rounded-3xl bg-[#f6f2ea] p-7 text-center shadow-xl">
            <h2 className="font-klossete text-3xl text-[#d14332]">
              {phase === "finish" ? "i mål!" : "pause"}
            </h2>
            {phase === "finish" && (
              <p className="font-klossete text-lg text-[#473f33]">{result.time.toFixed(1)} s</p>
            )}
            <div className="flex w-full flex-col gap-2.5">
              {phase === "paused" && (
                <button
                  type="button"
                  onClick={() => setPhase("run")}
                  className="font-klossete flex items-center justify-center gap-2 rounded-2xl bg-[#2b56be] px-6 py-3 text-xl text-[#f6f2ea] transition active:scale-95"
                >
                  <Play className="h-5 w-5" /> hald fram
                </button>
              )}
              <button
                type="button"
                onClick={restart}
                className="font-klossete flex items-center justify-center gap-2 rounded-2xl bg-[#e7e1d5] px-6 py-3 text-xl text-[#473f33] transition active:scale-95"
              >
                <RotateCcw className="h-5 w-5" /> køyr om att
              </button>
              <Link
                href="/"
                className="font-klossete flex items-center justify-center gap-2 rounded-2xl px-6 py-2 text-base text-[#9a9082] transition hover:text-[#6b6155] active:scale-95"
              >
                <Home className="h-4 w-4" /> hovudmeny
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------- */
/*  In-canvas scene: lights, track, scenery, the can + camera + dust          */
/* ------------------------------------------------------------------------- */
function Scene({
  track,
  steerRef,
  phaseRef,
  hud,
  onFinish,
}: {
  track: Track
  steerRef: React.MutableRefObject<number>
  phaseRef: React.MutableRefObject<Phase>
  hud: Hud
  onFinish: (time: number) => void
}) {
  const body = useRef<RapierRigidBody>(null)
  const canRef = useRef<THREE.Group>(null)
  const lightRef = useRef<THREE.DirectionalLight>(null)
  const lightTarget = useMemo(() => new THREE.Object3D(), [])
  const camera = useThree((s) => s.camera)

  // Mutable sim state kept out of React.
  const sim = useRef({
    seg: 0, // nearest centreline index (monotonic-ish progress)
    checkpoint: 3, // sample index to respawn at
    time: 0,
    q: new THREE.Quaternion(), // the can's visual orientation, integrated per-frame
    forward: track.startDir.clone(),
    camLook: new THREE.Vector3(), // smoothed camera aim point
    finished: false,
  }).current

  // Seed the camera behind the start line, its aim down the course, and the
  // can's orientation so its length axis lies across the start direction.
  useEffect(() => {
    const f = track.startDir
    const axis0 = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), f).normalize()
    sim.q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis0)
    sim.camLook.copy(track.start).addScaledVector(f, 5)
    camera.position.copy(track.start).addScaledVector(f, -CAM_BACK).add(new THREE.Vector3(0, CAM_UP, 0))
    camera.lookAt(sim.camLook)
  }, [camera, track, sim])

  const respawn = useCallback(() => {
    const sm = track.samples[sim.checkpoint]
    body.current?.setTranslation(
      { x: sm.p.x, y: sm.p.y + CAN_R + 0.5, z: sm.p.z },
      true,
    )
    body.current?.setLinvel({ x: 0, y: 0, z: 0 }, true)
    body.current?.setAngvel({ x: 0, y: 0, z: 0 }, true)
    sim.forward.copy(sm.t)
  }, [track, sim])

  useFrame((_state, dtRaw) => {
    const dt = Math.min(dtRaw, 1 / 30) // clamped for stable physics impulses
    const rb = body.current
    if (!rb) return
    const running = phaseRef.current === "run"

    const tr = rb.translation()
    const pos = new THREE.Vector3(tr.x, tr.y, tr.z)
    const lv = rb.linvel()
    const vel = new THREE.Vector3(lv.x, lv.y, lv.z)

    if (running && !sim.finished) sim.time += dt

    // Track the nearest centreline sample by walking forward from the last one.
    let best = sim.seg
    let bestD = pos.distanceToSquared(track.samples[best].p)
    for (let i = sim.seg; i < Math.min(sim.seg + 14, track.samples.length); i++) {
      const d = pos.distanceToSquared(track.samples[i].p)
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    sim.seg = best
    const sm = track.samples[best]
    if (best > sim.checkpoint) sim.checkpoint = best - 1

    // Forward direction: blend the velocity heading with the track tangent so a
    // near-stopped can still aims sensibly down the course.
    const horiz = new THREE.Vector3(vel.x, 0, vel.z)
    const speed = horiz.length()
    const aim = speed > 1.5 ? horiz.clone().normalize() : sm.t.clone()
    sim.forward.lerp(aim, 0.12).normalize()
    const fwd = sim.forward

    if (running) {
      // Steering: lateral acceleration across the direction of travel.
      const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize()
      const steer = steerRef.current
      const imp = right.multiplyScalar(steer * STEER * dt)
      // A forward nudge keeps momentum through flat patches and overcomes the
      // rolling friction that would otherwise stall a gentle downhill.
      imp.addScaledVector(fwd, 7 * dt)
      rb.applyImpulse({ x: imp.x, y: 0, z: imp.z }, true)

      // Speed clamp so the can never tunnels or runs away downhill.
      const sp = vel.length()
      if (sp > MAX_SPEED) {
        const k = MAX_SPEED / sp
        rb.setLinvel({ x: vel.x * k, y: vel.y * k, z: vel.z * k }, true)
      }

      // Fell off the course → back to the last checkpoint.
      if (pos.y < sm.p.y - 7) respawn()

      // Reached the end.
      if (!sim.finished && best >= track.samples.length - 6) {
        sim.finished = true
        rb.setLinvel({ x: 0, y: 0, z: 0 }, true)
        onFinish(sim.time)
      }

      // Progress readout.
      if (hud.progEl) {
        const pct = Math.round((best / (track.samples.length - 1)) * 100)
        hud.progEl.textContent = `${pct}%`
      }
    }

    // --- Visual barrel-roll, integrated incrementally so it never snaps when
    // steering. Each frame we (1) yaw the can a hair so its length axis keeps
    // lying across the travel direction, then (2) spin it about that axis by
    // distance / radius. Small per-frame deltas avoid the twist ambiguity that a
    // from-scratch alignment hits in the turns.
    const targetAxis = new THREE.Vector3().crossVectors(UP3, fwd).normalize()
    const curAxis = UP3.clone().applyQuaternion(sim.q).normalize()
    sim.q.premultiply(new THREE.Quaternion().setFromUnitVectors(curAxis, targetAxis))
    sim.q.premultiply(new THREE.Quaternion().setFromAxisAngle(targetAxis, (speed / CAN_R) * dt))
    if (canRef.current) {
      canRef.current.position.copy(pos)
      canRef.current.quaternion.copy(sim.q)
    }

    // --- Chase camera. The rig is pinned a fixed distance directly behind and
    // above the can, so the can is ALWAYS centred in frame with zero follow lag
    // (the heading `fwd` is already smoothed, which is what keeps the turns from
    // feeling jerky). Only the aim point is eased — and with REAL elapsed time,
    // not the clamped physics step, so it stays tight at any frame rate.
    camera.position.copy(pos).addScaledVector(fwd, -CAM_BACK).add(new THREE.Vector3(0, CAM_UP, 0))
    // aim ahead of and below the can so the descending road fills the lower
    // frame while the can sits centred.
    const lookGoal = pos.clone().addScaledVector(fwd, 4).add(new THREE.Vector3(0, -1.0, 0))
    sim.camLook.lerp(lookGoal, 1 - Math.pow(0.0001, dtRaw))
    camera.lookAt(sim.camLook)

    // --- Sun follows the can so its shadow is always crisp underneath.
    if (lightRef.current) {
      lightRef.current.position.set(pos.x + 8, pos.y + 18, pos.z + 6)
      lightTarget.position.copy(pos)
      lightTarget.updateMatrixWorld()
    }
  })

  return (
    <>
      <hemisphereLight intensity={0.55} color="#fffaf0" groundColor="#b9b2a4" />
      <ambientLight intensity={0.35} color="#fff3e3" />
      <directionalLight
        ref={lightRef}
        intensity={1.5}
        color="#fff4e2"
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-near={1}
        shadow-camera-far={60}
        shadow-camera-left={-16}
        shadow-camera-right={16}
        shadow-camera-top={16}
        shadow-camera-bottom={-16}
        shadow-bias={-0.0008}
        target={lightTarget}
      />
      <primitive object={lightTarget} />

      {/* Road + curbs (a single fixed trimesh) */}
      <RigidBody type="fixed" colliders="trimesh" friction={0.9} restitution={0}>
        <mesh geometry={track.geometry} receiveShadow>
          <meshStandardMaterial vertexColors roughness={0.95} metalness={0} />
        </mesh>
      </RigidBody>

      <Scenery decos={track.decos} />
      <Flags gates={track.gates} />

      {/* The red can */}
      <RigidBody
        ref={body}
        colliders={false}
        ccd
        canSleep={false}
        position={[track.start.x, track.start.y, track.start.z]}
        friction={0.7}
        restitution={0.05}
        linearDamping={0.04}
        angularDamping={0.15}
      >
        <BallCollider args={[CAN_R]} />
      </RigidBody>
      <group ref={canRef}>
        <Can />
      </group>
    </>
  )
}

/* Grey block scenery, batched into one instanced mesh for cheap draws. */
function Scenery({ decos }: { decos: Track["decos"] }) {
  const ref = useRef<THREE.InstancedMesh>(null)
  useEffect(() => {
    const inst = ref.current
    if (!inst) return
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const s = new THREE.Vector3()
    const p = new THREE.Vector3()
    const col = new THREE.Color()
    decos.forEach((d, i) => {
      p.set(d.pos[0], d.pos[1], d.pos[2])
      q.setFromEuler(new THREE.Euler(0, d.rotY, 0))
      s.set(d.size[0], d.size[1], d.size[2])
      m.compose(p, q, s)
      inst.setMatrixAt(i, m)
      inst.setColorAt(i, col.setRGB(d.shade, d.shade * 0.99, d.shade * 0.96))
    })
    inst.instanceMatrix.needsUpdate = true
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true
  }, [decos])
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, decos.length]} castShadow receiveShadow>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial roughness={0.96} metalness={0} />
    </instancedMesh>
  )
}

/* A pair of red flags marking each gate. */
function Flags({ gates }: { gates: Track["gates"] }) {
  return (
    <>
      {gates.map((g, i) => (
        <group key={i}>
          <Flag pos={g.left} />
          <Flag pos={g.right} />
        </group>
      ))}
    </>
  )
}
function Flag({ pos }: { pos: THREE.Vector3 }) {
  return (
    <group position={pos}>
      <mesh position={[0, 0.7, 0]} castShadow>
        <cylinderGeometry args={[0.05, 0.05, 1.4, 8]} />
        <meshStandardMaterial color="#efe9dd" roughness={0.9} />
      </mesh>
      <mesh position={[0.32, 1.18, 0]} castShadow>
        <boxGeometry args={[0.62, 0.4, 0.04]} />
        <meshStandardMaterial color="#d8392c" roughness={0.6} side={THREE.DoubleSide} />
      </mesh>
    </group>
  )
}

/* The player: the puzzle levels' red cylinder block, scaled to a rolling can.
   Its length axis is local +Y, which the chase loop lays across the travel
   direction so it rolls on its round side. */
function Can() {
  const { scene } = useGLTF(CAN_GLB)
  const model = useMemo(() => {
    const clone = scene.clone(true)
    clone.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (mesh.isMesh) mesh.castShadow = true
    })
    return clone
  }, [scene])
  return <primitive object={model} scale={CAN_SCALE} dispose={null} />
}
useGLTF.preload(CAN_GLB)
