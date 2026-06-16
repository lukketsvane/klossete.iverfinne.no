import { useEffect } from "react"
import { useThree } from "@react-three/fiber"
import * as THREE from "three"
import { CAM_FOV, boxLayout, viewTarget } from "@/lib/layout"

// Top-down camera: looks straight down the +Y axis at the origin, framed so the
// playable box (and a little margin) always fits, on any aspect ratio.
export function CameraRig() {
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)

  useEffect(() => {
    const aspect = size.width / size.height
    const { dist } = boxLayout(aspect, viewTarget(size.width, size.height))

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
