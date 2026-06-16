# Architecture & 50‑Level Plan

> Goal: grow from ~10 bespoke "rooms" into **50 levels**, each with its own
> *secret/key* to discover. **Linear** progression (solve → victory → next).
> Each level is a self‑contained module; the engine is shared.

## Why refactor

Today everything lives in one ~3,100‑line `components/wooden-blocks.tsx`:
blocks, physics, the grab servo, tilt, sound hookup, ~11 room components, 3
puzzle controllers, shaders, post‑FX **and** the UI. A level is spread across
`EnvConfig` + the `ENVIRONMENTS` array + the `Room()` switch + per‑env flags +
`SceneContents` wiring — adding one touches 5+ places, and there is **no
progression** (rooms just cycle on a button). This will not reach 50.

## Target shape

```
lib/
  blocks.ts        // catalogue, types, mesh assets, helpers (radius, pitch)
  layout.ts        // camera + box/wall layout, viewTarget
  audio.ts         // (today's impact-sound.ts)
  progression.ts   // ordered levels, current index, solved set, localStorage
components/
  engine/
    Stage.tsx        // <Canvas> shell: background, post‑FX composer, resize
    CameraRig.tsx
    BlockField.tsx   // spawns BLOCKS + grab/drag servo + containment + sound
    TiltController.tsx
    context.tsx      // <LevelContext> -> bodies, box, world, dragRef, audio, helpers
    types.ts         // Level, LevelContext, Theme
  rooms/             // reusable visual kit: shaders.ts, textures.ts, lights.tsx
  hud/LevelHud.tsx   // tiny: level number, solved flash, transition
  Game.tsx           // progression + engine + current level + hud
levels/
  index.ts           // ORDERED registry: [level01, level02, ...]
  _template.tsx
  01-…  02-…  …  50-…
```

Adding a level = **one file in `levels/` + one line in `index.ts`.**

## The `Level` contract

```ts
type LevelContext = {
  bodies: Ref<Record<string, RapierRigidBody | null>>
  box: Box
  setGravity(v: Vec3): void
  setFloor(on: boolean): void
  scatter(opts?): void
  dragRef: Ref<DragState | null>
  audio: { playImpact; playTone; playBeep }
}

type Level = {
  id: string
  name: string
  hint?: string                 // a subtle nudge toward the secret
  theme: Theme                  // bg, key light, contact, bloom, fog, post‑fx
  Room: FC                      // visuals: floor/walls/shaders/lights/extra meshes
  init?(ctx): () => void        // gravity, floor on/off, spawn/scatter overrides
  useSolved(ctx): boolean       // THE secret / win condition (a hook)
  Victory?: FC<{ ctx }>         // celebration + animation on solve
}
```

The engine mounts the active level: runs `init`, renders `<Room/>`, evaluates
`useSolved`. On solved → render `Victory` (~2 s) → `progression.advance()` →
next level mounts fresh. Block visuals/physics are shared; a level overrides
behaviour (flat/invisible pieces, zero‑g, no floor, scatter…) via `theme`/`init`.

## Progression (linear)

- `progression.ts`: `LEVEL_ORDER` from the registry, `current` index,
  `solved: Set<id>`, persisted to `localStorage` (`klossete:progress`).
- Flow: enter → discover the key → `useSolved` true → `Victory` → advance.
  Final level → a brief "complete" beat.
- Authoring: `?level=N` / a hidden chord to jump, behind a debug flag.
- HUD: minimal (a number + a solved flash) to honour the "no UI text" look.

## Migration — incremental, build‑green at every step

Each step is its own small PR; the app keeps building and behaviour is
preserved until progression is switched on. (Gameplay can only be eyeballed on
a deploy, so we validate visually when Vercel's daily cap resets.)

1. Extract shared `lib/` (blocks, layout, audio) — no behaviour change.
2. Engine shell (Stage / CameraRig / BlockField / Tilt) + `LevelContext`;
   render a single `<Level>` slot instead of the `Room()` switch.
3. Define the `Level` interface; port 3 simple rooms (concrete, gold, playmat).
4. Extract puzzle primitives; port the secrets: sort (klossete), align
   (projection), assemble (magnet), reactive (glass) — each with `useSolved`.
5. Port the remaining themed rooms (video, peel, texturemiss, fourthside).
6. Add progression + HUD; wire solve → advance + persistence.
7. Author toward 50 (idea bank below); write `LEVELS.md`.

## Secret/“key” idea bank (mostly unique gimmicks)

Existing → re‑homed as levels: colour‑sort (klossete), floor‑projection align,
magnet L‑assembly, reactive music tiles (glass), peel‑to‑reveal, "texture not
found" click, fourth‑side align, Morse celebration.

Net‑new secrets to design toward 50: stack to a target height; balance on a
point/seesaw; tilt‑pour every block through one gap; rotate a light so shadows
match a silhouette; overlap translucent blocks to mix a target colour; spot the
one fake/floating block; domino chain to a switch; knock a rhythm to unlock;
fit through a shrinking aperture against the clock; orbit blocks in a gravity
well; mirror‑room reflection spells a word; spell a word in Morse by knocking…
(detailed as we build).

## Risks

The monolith split is the riskiest part — kept to small, reversible PRs.
Visual validation waits on a deploy (free‑tier daily cap currently exhausted).
