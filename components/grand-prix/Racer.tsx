"use client"

import { useEffect, useMemo, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import { useGLTF } from "@react-three/drei"
import { BallCollider, RigidBody, type RapierRigidBody } from "@react-three/rapier"
import * as THREE from "three"
import { CYLINDER_SCALE, CYLINDER_URL, ROLL_RADIUS } from "@/lib/cylinder"
import { FALL_Y, TRACK, TRACK_WIDTH } from "@/lib/track"
import type { Steer } from "./useControls"

const ACCEL = 12 // steering force per unit mass
const MAX_SPEED = 12 // horizontal speed cap (units/s)
const CAM_DIST = 6.5
const CAM_HEIGHT = 3.6
const CAM_LOOK = 2.5
const CP_RADIUS = TRACK_WIDTH / 2 + 1.2

type Pose = { pos: THREE.Vector3; yaw: number }

function startPose(): Pose {
  const s = TRACK.start
  return { pos: new THREE.Vector3(s.pos[0], s.pos[1] + ROLL_RADIUS + 0.1, s.pos[2]), yaw: s.rot[1] }
}

export function Racer({
  running,
  resetToken,
  steer,
  speedRef,
  onCheckpoint,
  onFinish,
  onFall,
}: {
  running: boolean
  resetToken: number
  steer: React.MutableRefObject<Steer>
  speedRef: React.MutableRefObject<number>
  onCheckpoint: (index: number) => void
  onFinish: () => void
  onFall: () => void
}) {
  const body = useRef<RapierRigidBody>(null)
  const visual = useRef<THREE.Group>(null)
  const camera = useThree((s) => s.camera)

  const gltf = useGLTF(CYLINDER_URL)
  const model = useMemo(() => {
    const clone = gltf.scene.clone(true)
    clone.traverse((c) => {
      const m = c as THREE.Mesh
      if (m.isMesh) {
        m.castShadow = true
        m.receiveShadow = true
      }
    })
    return clone
  }, [gltf.scene])

  // mutable game state held in refs so the loop never re-renders
  const nextCp = useRef(1)
  const respawn = useRef<Pose>(startPose())
  const camForward = useRef(new THREE.Vector3(Math.sin(startPose().yaw), 0, Math.cos(startPose().yaw)))
  const rollAxis = useRef(new THREE.Vector3(1, 0, 0))
  const rollAngle = useRef(0)
  const finished = useRef(false)

  // place / reset the body
  const placeAt = (p: Pose) => {
    const b = body.current
    if (!b) return
    b.setTranslation({ x: p.pos.x, y: p.pos.y, z: p.pos.z }, true)
    b.setLinvel({ x: 0, y: 0, z: 0 }, true)
    b.setAngvel({ x: 0, y: 0, z: 0 }, true)
    camForward.current.set(Math.sin(p.yaw), 0, Math.cos(p.yaw))
  }

  useEffect(() => {
    nextCp.current = 1
    respawn.current = startPose()
    finished.current = false
    rollAngle.current = 0
    placeAt(startPose())
  }, [resetToken])

  useFrame((_, dtRaw) => {
    const b = body.current
    const vis = visual.current
    if (!b || !vis) return
    const dt = Math.min(dtRaw, 1 / 30)

    const t = b.translation()
    const pos = new THREE.Vector3(t.x, t.y, t.z)
    const lv = b.linvel()
    const vel = new THREE.Vector3(lv.x, lv.y, lv.z)
    const horizSpeed = Math.hypot(lv.x, lv.z)
    speedRef.current = horizSpeed

    // before the race starts, hold the cylinder parked at the start (otherwise it
    // would just roll off down the hill on the title screen)
    if (!running && !finished.current) {
      placeAt(respawn.current)
      const fwd0 = camForward.current
      camera.position.lerp(
        new THREE.Vector3().copy(respawn.current.pos).addScaledVector(fwd0, -CAM_DIST).add(new THREE.Vector3(0, CAM_HEIGHT, 0)),
        1 - Math.pow(0.001, dt),
      )
      camera.lookAt(new THREE.Vector3().copy(respawn.current.pos).addScaledVector(fwd0, CAM_LOOK))
      vis.position.copy(respawn.current.pos)
      return
    }

    // safety net: a rare solver spike should never fling the cylinder into orbit —
    // if it's moving impossibly fast or has left the world, snap back.
    if (horizSpeed > 28 || pos.y > TRACK.start.pos[1] + 8) {
      placeAt(respawn.current)
      onFall()
      return
    }

    // --- steering (only while the race is live and not finished) ---
    if (running && !finished.current) {
      const s = steer.current
      const fwd = camForward.current
      const right = new THREE.Vector3(fwd.z, 0, -fwd.x)
      const dir = new THREE.Vector3()
        .addScaledVector(fwd, s.y)
        .addScaledVector(right, s.x)
      if (dir.lengthSq() > 1e-4) {
        dir.normalize()
        const mass = b.mass() || 1
        b.addForce({ x: dir.x * ACCEL * mass, y: 0, z: dir.z * ACCEL * mass }, true)
      }
      // speed cap
      if (horizSpeed > MAX_SPEED) {
        const k = MAX_SPEED / horizSpeed
        b.setLinvel({ x: lv.x * k, y: lv.y, z: lv.z * k }, true)
      }
    }

    // --- fell off? respawn ---
    if (pos.y < FALL_Y) {
      placeAt(respawn.current)
      onFall()
      return
    }

    // --- checkpoints ---
    if (running && !finished.current && nextCp.current < TRACK.checkpoints.length) {
      const cp = TRACK.checkpoints[nextCp.current]
      const d = Math.hypot(pos.x - cp.pos[0], pos.z - cp.pos[2])
      if (d < CP_RADIUS && Math.abs(pos.y - cp.pos[1]) < 4) {
        if (cp.finish) {
          finished.current = true
          onFinish()
        } else {
          respawn.current = {
            pos: new THREE.Vector3(cp.pos[0], cp.pos[1] + ROLL_RADIUS + 0.1, cp.pos[2]),
            yaw: cp.rot[1],
          }
          onCheckpoint(cp.index)
        }
        nextCp.current += 1
      }
    }

    // --- chase camera: follow, yaw toward travel ---
    if (horizSpeed > 0.8) {
      const target = new THREE.Vector3(vel.x, 0, vel.z).normalize()
      camForward.current.lerp(target, 1 - Math.pow(0.0015, dt)).normalize()
    }
    const fwd = camForward.current
    const camPos = new THREE.Vector3()
      .copy(pos)
      .addScaledVector(fwd, -CAM_DIST)
      .add(new THREE.Vector3(0, CAM_HEIGHT, 0))
    camera.position.lerp(camPos, 1 - Math.pow(0.0001, dt))
    const look = new THREE.Vector3().copy(pos).addScaledVector(fwd, CAM_LOOK)
    camera.lookAt(look)

    // --- rolling cylinder visual (decoupled from the ball's own spin) ---
    vis.position.copy(pos)
    if (horizSpeed > 0.3) {
      const axis = new THREE.Vector3(vel.z, 0, -vel.x).normalize()
      rollAxis.current.lerp(axis, 1 - Math.pow(0.002, dt)).normalize()
    }
    rollAngle.current += (horizSpeed * dt) / ROLL_RADIUS
    const qAlign = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      rollAxis.current,
    )
    const qSpin = new THREE.Quaternion().setFromAxisAngle(rollAxis.current, rollAngle.current)
    vis.quaternion.copy(qSpin).multiply(qAlign)
  })

  const sp = startPose()

  return (
    <>
      <RigidBody
        ref={body}
        colliders={false}
        position={[sp.pos.x, sp.pos.y, sp.pos.z]}
        friction={1.1}
        restitution={0.05}
        linearDamping={0.25}
        angularDamping={0.15}
        density={3}
        canSleep={false}
        ccd
      >
        <BallCollider args={[ROLL_RADIUS]} />
      </RigidBody>

      <group ref={visual} scale={CYLINDER_SCALE}>
        <primitive object={model} dispose={null} />
      </group>
    </>
  )
}

useGLTF.preload(CYLINDER_URL)
