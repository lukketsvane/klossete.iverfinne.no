// The red cylinder — the one piece we carry over from kl.oss.ete into the
// Grand Prix. The GLB was authored standing upright with its length along the
// local +Y axis (native ≈ Ø1.35 × H2.7 scene units). Here it becomes a rolling
// roller, so the renderer aligns that +Y length axis across the direction of
// travel and spins the mesh about it.
export const CYLINDER_URL = "/block_red_cylinder.glb"
export const CYLINDER_COLOR = "#c83a2e"

// Physics is a ball (rolls cleanly in any direction); the visible roller is
// sized to wrap that ball. The ball radius is the roll radius.
export const ROLL_RADIUS = 0.62

// Non-uniform scale applied to the native GLB so the round cross-section keeps
// the roll radius while the length is shortened to a chunky roller.
// native radius ≈ 0.675, native half-length ≈ 1.35.
export const CYLINDER_SCALE: [number, number, number] = [
  ROLL_RADIUS / 0.675, // x — cross-section
  0.78 / 1.35, // y — length (half-length ≈ 0.78)
  ROLL_RADIUS / 0.675, // z — cross-section
]
