# Artistic concrete texture set — classification

Source: `public/artistic concrete textures/` (ChatGPT-generated, 1254×1254, seamless).
Classified by decoding each PNG and measuring mean RGB / saturation / normal-map-blue
fraction (see `scripts/classify-textures.mjs`).

**25 maps = 3 albedo · 10 normal · 12 grayscale (roughness/AO).**

Working set copied here with clean names (used by the app):

| Clean name | Source file | Role |
|---|---|---|
| `concrete_albedo.png` | `04_45_51 PM (4)` | Albedo — neutral gray concrete |
| `concrete_albedo_warm.png` | `04_45_51 PM (1)` | Albedo — warm beige concrete |
| `concrete_normal.png` | `04_45_54 PM (1)` | Normal map (fine grain) |
| `concrete_roughness.png` | `04_45_56 PM (6)` | Roughness (soft mottling) |

## Full classification

ALBEDO / diffuse (color, low-saturation concrete):
- `04_45_51 PM (1)` — warm beige
- `04_45_51 PM (3)` — warm beige (more mottled)
- `04_45_51 PM (4)` — neutral gray

NORMAL maps (blue/purple, B≈250, sat≈0.52):
- `04_45_54 PM (1)`, `04_45_54 PM (2)`, `04_45_55 PM (3)`, `04_45_55 PM (4)`, `04_45_55 PM (5)`,
  `04_45_58 PM (1)`, `04_45_58 PM (3)`, `04_45_58 PM (5)`, `04_45_58 PM (7)`, `04_45_59 PM (9)`

GRAYSCALE data maps (roughness / AO / height — R≈G≈B):
- `04_45_51 PM (2)`, `04_45_51 PM (5)`, `04_45_56 PM (6)`, `04_45_56 PM (7)`, `04_45_56 PM (8)`,
  `04_45_56 PM (9)`, `04_45_58 PM (2)`, `04_45_58 PM (4)`, `04_45_58 PM (6)`, `04_45_58 PM (8)`,
  `04_45_59 PM (10)`, `04_45_59 PM (10) (1)`
