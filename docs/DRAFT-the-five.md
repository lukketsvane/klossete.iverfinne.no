# Design draft — "The Five" (play each block, then build the Messias)

> Status: **draft** for the levels after the Maze. References live alongside
> this file: `design/floors/mosaic-1..4.png` (block-mosaic floors) and
> `design/figure/messias-reference.jpeg` (the figure to construct).

## The idea

One big finale level, split into **five solo stages + one assembly stage**.
In each solo stage you **are** one of the five blocks, alone on its own
mosaic floor, and move it through a short journey. When all five have made
their way, they reunite and the player **constructs the Messias figure** — the
little standing person on water from the reference photo.

It pays off the running thread: the blocks you've dragged around all game now
become *characters*, and the figure that kept trying to assemble itself in the
maze finally gets built by hand.

## The five solo stages (one block each)

Each block moves in a way that suits its shape — a generalisation of the maze's
"flip-flop" rolling. Camera follows top-down, exactly like the maze.

| # | Block | Colour | Movement verb | Floor |
|---|-------|--------|---------------|-------|
| 1 | Cube | light blue | **tip / roll** 90° edge-over-edge (the maze verb) | `mosaic-1` (cool blues) |
| 2 | Cylinder | red | **roll** along its side; goes straight until you stand it on end to turn | `mosaic-4` (warm/red) |
| 3 | Orange slab | orange | **tumble** end-over-end (long axis), covers ground fast | `mosaic-2` (orange/blue) |
| 4 | Long plank | blue | **tip** end-over-end; long reach, bridges gaps | `mosaic-3` |
| 5 | Short plank | blue | **tip** end-over-end; tighter, fits narrow gaps | `mosaic-2` |

Each stage is a short, readable challenge (≈20–40s):

- **Cube** — a tidy intro maze (reuse the maze engine at a smaller size).
- **Cylinder** — a "lane" puzzle: it rolls straight forever, so you plan when
  to stand it up to change lanes and reach the goal (its quirk = the puzzle).
- **Orange slab** — stepping-stone gaps: tumbling lands flat/upright
  alternately, so you time tumbles to land on solid tiles, not the voids.
- **Long plank** — bridge a gap: tip it so it falls *across* a missing run of
  floor, then walk the rest.
- **Short plank** — a tight switchback; its shorter reach is the constraint.

Shared rules: kinematic, grid-based, deterministic (no physics fighting — the
maze's lesson). Reaching each stage's goal tile transitions to the next block.

## Floors (the mosaics)

The four provided tiles become the **floors** of the solo stages — they're
block-mosaics, so they tie the world to the pieces. Notes:

- They are photos, not seamless tiles; use each as a single large textured
  plane under its stage (camera never sees a hard seam if the plane is bigger
  than the play area), or run a subtle vignette/darken at the edges.
- Tint/lighting per stage can lean into the block's colour (red stage warmer,
  blue stages cooler) for instant identity.
- Asset prep: downscale to ~1024², `sRGB`, `wrapS/T = Clamp`, drop into
  `public/textures/floors/`.

## The assembly finale — build the Messias

All five arrive on a shared stage (calm, single mosaic, a soft spotlight).
Five faint **ghost slots** show the target poses of the figure:

```
            [orange]        ← head
            [cylinder]      ← body, standing
   [cube]                   ← shoulder/pelvis at the base
[plank-long][plank-short]   ← the "water" the figure stands on (laid flat)
```

(Matches `design/figure/messias-reference.jpeg`.)

Interaction: drag each block onto its ghost; it **snaps** when close (reuse the
magnet/totem click-lock, which already does pose-snap cleanly). When the last
piece seats, the figure lights up, rises slightly, and the level — and the run —
resolves with a bloom + a held beat.

Because the camera is top-down, the figure is authored **flat-readable** (laid
down, like the maze's removed assembly) *or* the camera tilts to a 3/4 hero
angle for the reveal only. Recommend the **camera-tilt reveal**: assemble flat,
then ease the camera to ~35° to show it standing for the final shot.

## How it maps to the engine (low-risk build plan)

1. **Generalise the maze controller** into a `RollController(blockId, verb,
   maze)` — the cube already does `tip`; add `roll` (cylinder) and `tumble`
   (slab/planks) as variants of the same kinematic-pose animation. Each solo
   stage = a small grid + a goal, reusing this.
2. **One env per stage** (5) routed to a `MosaicRoom` that takes a floor
   texture; only the active block is rendered (the maze pattern — fixes the
   "other blocks shouldn't be here" issue for free).
3. **Assembly stage** = a `FigureController` reusing the totem click-lock with
   the Messias poses + the camera-tilt reveal.
4. Slot these six envs into the progression after the Maze; they fill six of
   the remaining board squares with genuinely distinct gimmicks.

## Open questions for you

- Solo-stage difficulty: quick & toy-like, or actual head-scratchers?
- Final reveal: flat top-down, or the 3/4 camera-tilt hero shot?
- Do the planks get separate stages (5 total) or share one (4 stages)?
