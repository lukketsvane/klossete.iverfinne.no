# kl.oss.ete typeface

A modular blocky display face generated from the hand-designed glyph sheet
(`design/klossete-glyph-sheet.png`).

Files: `KlOssEte-Regular.{otf,ttf,woff2,woff}` — 100 glyphs:
A–Z, a–z, 0–9, Æ Ø Å æ ø å, punctuation `. , : ; ! ? ' " ( ) [ ] { }`,
symbols `/ \ - _ + = * & % # @ $`, and `€ < > | ^ ~`.

Use via the `@font-face` in `app/globals.css` (family **`kl.oss.ete`**, or the
`.font-klossete` class).

## Rebuild
`python3 scripts/build-font.py` (needs `pip install pillow numpy scikit-image fonttools[woff] zopfli`).
It segments each row of the sheet to its exact glyph count, traces every glyph
with scikit-image contours, and assembles the OTF/TTF/WOFF/WOFF2 with fontTools.
