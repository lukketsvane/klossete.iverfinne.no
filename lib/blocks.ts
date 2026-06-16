// The wooden-block catalogue: types, GLB mesh assets, the five blocks, and small
// size/pitch helpers. Level-agnostic and hook-free so the engine and any level
// can import it.
import * as THREE from "three"

const S = 0.036 // 1 mm -> scene units (blocks sized to sit smaller in the tray)
// The GLB block meshes were authored to match colliders at this scale. The
// visual is scaled by S / MESH_DESIGN_S so the mesh and its cuboid collider
// always stay the same size – change S alone and they drift apart (blocks
// float / interpenetrate), so the visual must scale with it.
const MESH_DESIGN_S = 0.045
export const MESH_FIT = S / MESH_DESIGN_S

export type BlockMeshAsset = {
  url: string
}

export type BlockBase = {
  id: string
  name: string
  color: string
  dims: string
  pos: [number, number, number]
  rot?: [number, number, number]
  mesh: BlockMeshAsset
}

export type BoxBlock = {
  shape: "box"
  half: [number, number, number]
} & BlockBase
export type CylBlock = {
  shape: "cylinder"
  radius: number
  halfHeight: number
} & BlockBase
export type Block = BoxBlock | CylBlock

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

export const REST = 0.06 // small gap above floor when spawning

export const BLOCKS: Block[] = [
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

// Horizontal bounding radius of a block – the margin to keep it off the walls
// no matter how it is rotated about the vertical axis.
export function blockRadius(b: Block) {
  return b.shape === "cylinder" ? b.radius : Math.hypot(b.half[0], b.half[2])
}

// Largest real dimension of a block in mm – longer pieces ring at a lower pitch.
function blockMaxMm(b: Block) {
  const u = b.shape === "cylinder" ? Math.max(b.radius * 2, b.halfHeight * 2) : Math.max(...b.half) * 2
  return u / S
}

// Fundamental impact frequency: bigger block -> lower knock.
export function blockBaseFreq(b: Block) {
  return THREE.MathUtils.clamp(2600 / Math.sqrt(blockMaxMm(b)), 230, 680)
}
