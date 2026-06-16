# Realistic Wooden Blocks

An interactive 3D physics sandbox of realistic wooden building blocks. Drag to
slide the blocks across the floor, flick to throw them, and toggle measure mode
to inspect each block's real-world dimensions.

Built with **Next.js 16**, **React Three Fiber**, **drei**, and the **Rapier**
physics engine.

## Features

- Real-time rigid-body physics (drag, slide, throw, stack)
- Blocks sized to real millimetre dimensions, scaled into the scene
- Invisible walls fitted to the visible camera frustum so blocks stay in view
- Responsive camera rig that keeps the play area framed on any aspect ratio
  (including tall phone portrait screens)
- Measure mode to reveal each block's name and dimensions
- Reset button to return every block to its starting pose

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

## Project structure

- `app/` – Next.js App Router entry, layout, and global styles
- `components/wooden-blocks.tsx` – the 3D scene, physics, and interaction logic
- `components/ui/` – shared UI primitives
- `lib/` – utilities
