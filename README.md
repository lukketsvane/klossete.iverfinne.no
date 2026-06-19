# Klossete Grand Prix

A focused little racing game: roll the red **kl.oss.ete** cylinder through a
foggy, minimalist obstacle course, hitting checkpoints on the way to the finish.
This branch is a fork that strips the original block sandbox down to **only** the
Grand Prix module — but keeps the cylinder.

Built with **Next.js 16**, **React Three Fiber**, **drei**, and the **Rapier**
physics engine.

## How it plays

- The cylinder rolls under tilt-style steering — a steering force in camera space.
- Steer with the **arrow keys / WASD**, an **on-screen joystick** (touch & mouse),
  or the device **tilt sensor** (toggle on the start screen; iOS asks permission).
- Roll through each checkpoint (the red flags). Fall off and you respawn at the
  last checkpoint. Reach the black-flag finish to stop the clock.

## Getting started

```bash
pnpm install
pnpm dev
```

Then open [http://localhost:3000](http://localhost:3000).

## Scripts

- `pnpm dev` – start the dev server
- `pnpm build` – production build
- `pnpm start` – run the production build
- `pnpm lint` – lint the project
- `pnpm test` – Playwright smoke test (boots the build, starts the race)

## Project structure

- `app/` – Next.js App Router entry, layout, and global styles
- `components/grand-prix/` – the game: `GrandPrix` (canvas + fog + post-fx),
  `Track`, `Racer` (player + chase camera + checkpoints), `Hud`, `useControls`
- `lib/track.ts` – the course centreline, ribbon/rail geometry, checkpoints
- `lib/cylinder.ts` – the red cylinder asset + sizing
