"use client"

import { useMemo } from "react"
import { useGLTF, useTexture } from "@react-three/drei"
import { RigidBody } from "@react-three/rapier"
import * as THREE from "three"
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js"
import {
  FLOOR_THICK,
  RAIL_HEIGHT,
  RAIL_THICK,
  TRACK,
  TRACK_WIDTH,
  type Feature,
  type Piece,
} from "@/lib/track"

// Merge a set of placed boxes into one geometry (one draw call instead of
// hundreds). Each piece is a box of the given cross-section, length along X.
function mergePieces(pieces: Piece[], thick: number, width: number) {
  const geos = pieces.map((p) => {
    const g = new THREE.BoxGeometry(p.len, thick, width)
    g.applyMatrix4(
      new THREE.Matrix4().compose(
        new THREE.Vector3(...p.pos),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(...p.rot)),
        new THREE.Vector3(1, 1, 1),
      ),
    )
    return g
  })
  return mergeGeometries(geos, false)
}

// A triangular-prism wedge matching a ramp's footprint: low edge at +Z (buried a
// little below the surface so it blends into the floor), high edge at -Z. Baked
// into the floor mesh so the cylinder rolls onto it as one continuous surface.
function wedgeGeometry(f: Feature) {
  const [w, h, d] = f.dims
  const hx = w / 2
  const dz = d / 2
  const baseY = -0.6
  const topY = h
  // prettier-ignore
  const pos = new Float32Array([
    -hx, baseY,  dz,   hx, baseY,  dz,
    -hx, baseY, -dz,   hx, baseY, -dz,
    -hx, topY,  -dz,   hx, topY,  -dz,
  ])
  // prettier-ignore
  const idx = [
    0,1,5, 0,5,4,   // slope
    3,2,4, 3,4,5,   // back
    0,3,2, 0,1,3,   // bottom
    0,2,4,          // left
    1,5,3,          // right
  ]
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3))
  // a uv channel so this merges cleanly with the ribbon boxes (which carry uvs)
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(6 * 2), 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  g.applyMatrix4(
    new THREE.Matrix4().compose(
      new THREE.Vector3(...f.pos),
      new THREE.Quaternion(...f.quat),
      new THREE.Vector3(1, 1, 1),
    ),
  )
  return g
}

export function Track() {
  const [albedo, normal, rough] = useTexture([
    "/textures/concrete/concrete_albedo_warm.png",
    "/textures/concrete/concrete_normal.png",
    "/textures/concrete/concrete_roughness.png",
  ])
  useMemo(() => {
    albedo.colorSpace = THREE.SRGBColorSpace
    for (const t of [albedo, normal, rough]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping
      t.repeat.set(1, 1)
      t.anisotropy = 8
      t.needsUpdate = true
    }
  }, [albedo, normal, rough])

  // Floor collision + base visual: the ribbon with the ramp wedges merged in, so
  // it is ONE continuous trimesh — no separate ramp colliders to pinch against.
  const floorGeo = useMemo(() => {
    const ribbon = TRACK.floor.map((p) => {
      const g = new THREE.BoxGeometry(p.len, FLOOR_THICK, TRACK_WIDTH)
      g.applyMatrix4(
        new THREE.Matrix4().compose(
          new THREE.Vector3(...p.pos),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(...p.rot)),
          new THREE.Vector3(1, 1, 1),
        ),
      )
      return g
    })
    const wedges = TRACK.features.map(wedgeGeometry)
    return mergeGeometries([...ribbon, ...wedges], false)
  }, [])
  const railGeo = useMemo(() => mergePieces(TRACK.rails, RAIL_THICK, RAIL_HEIGHT), [])

  return (
    <>
      <RigidBody type="fixed" colliders="trimesh" friction={0.95} restitution={0}>
        <mesh geometry={floorGeo} receiveShadow castShadow>
          <meshStandardMaterial
            map={albedo}
            normalMap={normal}
            normalScale={new THREE.Vector2(0.5, 0.5)}
            roughnessMap={rough}
            roughness={1}
            metalness={0}
            color="#d8cdb8"
          />
        </mesh>
      </RigidBody>

      <RigidBody type="fixed" colliders="trimesh" friction={0.4} restitution={0.05}>
        <mesh geometry={railGeo} receiveShadow castShadow>
          <meshStandardMaterial color="#cabfa9" roughness={0.95} metalness={0} />
        </mesh>
      </RigidBody>

      <RampVisuals />
      <BackgroundBlocks />
      <Checkpoints />
    </>
  )
}

// The pretty ramp GLBs, sitting on top of their baked wedges — visual only.
function RampVisuals() {
  return (
    <>
      {TRACK.features.map((f, i) => (
        <RampMesh key={i} feature={f} />
      ))}
    </>
  )
}

function RampMesh({ feature }: { feature: Feature }) {
  const gltf = useGLTF(feature.url)
  const model = useMemo(() => {
    const clone = gltf.scene.clone(true)
    clone.traverse((c) => {
      const m = c as THREE.Mesh
      if (m.isMesh) m.receiveShadow = true
    })
    return clone
  }, [gltf.scene])
  return (
    <group position={feature.pos} quaternion={feature.quat} scale={feature.scale}>
      <primitive object={model} dispose={null} />
    </group>
  )
}

// Distant foggy skyline — visual only, no colliders.
function BackgroundBlocks() {
  return (
    <group>
      {TRACK.blocks.map((b, i) => (
        <mesh key={i} position={b.pos} rotation={[0, b.rot, 0]} castShadow receiveShadow>
          <boxGeometry args={b.size} />
          <meshStandardMaterial color="#cfc6b4" roughness={1} metalness={0} />
        </mesh>
      ))}
    </group>
  )
}

// The red marker flags at each checkpoint; the finish flag is darker + taller.
function Checkpoints() {
  return (
    <group>
      {TRACK.checkpoints.map((cp) => {
        if (cp.index === 0) return null
        const poleH = cp.finish ? 3.2 : 2.0
        return (
          <group key={cp.index} position={cp.pos} rotation={cp.rot}>
            <group position={[TRACK_WIDTH / 2 + 0.1, 0, 0]}>
              <mesh position={[0, poleH / 2, 0]} castShadow>
                <cylinderGeometry args={[0.06, 0.06, poleH, 8]} />
                <meshStandardMaterial color="#f6f2ea" roughness={0.9} />
              </mesh>
              <mesh position={[0.001, poleH - 0.35, 0.45]} castShadow>
                <boxGeometry args={[0.02, 0.55, 0.9]} />
                <meshStandardMaterial
                  color={cp.finish ? "#222222" : "#d14332"}
                  roughness={0.7}
                  emissive={cp.finish ? "#000000" : "#d14332"}
                  emissiveIntensity={cp.finish ? 0 : 0.15}
                />
              </mesh>
            </group>
          </group>
        )
      })}
    </group>
  )
}

useGLTF.preload("/models/ramp_01.glb")
useGLTF.preload("/models/ramp_02.glb")
useGLTF.preload("/models/ramp_03.glb")
useGLTF.preload("/models/ramp_04.glb")
