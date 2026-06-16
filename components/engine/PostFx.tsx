import { Bloom, EffectComposer, N8AO, SMAA, ToneMapping, Vignette } from "@react-three/postprocessing"
import { ToneMappingMode } from "postprocessing"

// Shared post-processing stack: ambient occlusion grounds the blocks, a gentle
// vignette adds depth, ACES tone mapping seats the contrast, SMAA cleans edges.
// Bloom is added for the gold + glass environments to make seams glow. A few
// params vary per environment id.
export function PostFx({ envId }: { envId: string }) {
  return (
    <EffectComposer key={envId} multisampling={0}>
      <N8AO aoRadius={0.8} intensity={envId === "glass" ? 1.4 : 1.3} distanceFalloff={1} halfRes color="#1c160e" />
      <Bloom
        intensity={envId === "gold" ? 0.75 : envId === "glass" ? 0.3 : 0}
        luminanceThreshold={envId === "glass" ? 0.9 : 0.55}
        luminanceSmoothing={0.2}
        mipmapBlur
      />
      <Vignette offset={0.35} darkness={envId === "glass" ? 0.28 : 0.24} />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      <SMAA />
    </EffectComposer>
  )
}
