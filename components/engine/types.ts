// The Level contract. The engine owns the shared world (blocks, physics, drag,
// camera, lighting, post-FX); a Level plugs in a themed Room, a secret/"key"
// win-condition, and an optional victory animation. Each level lives in its own
// module and is added to the registry — see docs/ARCHITECTURE.md.
//
// NOTE: this is the forward-looking contract introduced in Phase 2. The existing
// rooms are migrated onto it in later phases; nothing imports it yet.
import type { ReactNode } from "react"
import type { RapierRigidBody } from "@react-three/rapier"
import type { Box } from "@/lib/layout"

// Visual + lighting mood for a level.
export type Theme = {
  bg: string // canvas + page background
  keyColor: string
  keyIntensity: number
  contact: { color: string; opacity: number } // grounding contact shadow
  bloom: boolean
}

// Shared handles the engine hands to a level's puzzle logic.
export type LevelContext = {
  bodies: React.MutableRefObject<Record<string, RapierRigidBody | null>>
  box: Box
}

// A single level: a themed room, the secret win-condition, an optional victory.
export type Level = {
  id: string
  name: string
  hint?: string // a subtle nudge toward the secret
  theme: Theme
  Room: () => ReactNode // visuals: floor / walls / shaders / lights / extra meshes
  init?: (ctx: LevelContext) => void | (() => void) // gravity, floor on/off, scatter…
  useSolved: (ctx: LevelContext) => boolean // THE secret / key
  Victory?: (props: { ctx: LevelContext }) => ReactNode // celebration on solve
}
