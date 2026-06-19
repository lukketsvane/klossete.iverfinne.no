import next from "eslint-config-next/core-web-vitals"

// Flat config so `pnpm lint` (eslint .) works on Next 16, which no longer ships
// `next lint`. eslint-config-next v16 already exports a flat-config array, so we
// spread it directly. Kept deliberately lenient: this is a single-page WebGL
// game, so we surface real mistakes (unused vars, bad hooks) without drowning in
// react-three-fiber's custom-prop noise.
const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "_glb_originals_4k/**",
      "scripts/**",
      "design/**",
      "public/**",
    ],
  },
  ...next,
  {
    rules: {
      "@next/next/no-img-element": "off",
      "react/no-unknown-property": "off", // react-three-fiber uses many custom props
      // The newest react-hooks plugin ships react-compiler-era rules. This game
      // predates them and runs fine, so we keep them advisory (warn) rather than
      // blocking — they flag real follow-ups without failing `pnpm lint`.
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/purity": "warn",
    },
  },
]

export default config
