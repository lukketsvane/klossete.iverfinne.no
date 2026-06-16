import fs from "node:fs"
import zlib from "node:zlib"
import path from "node:path"

const DIR = path.resolve("public/artistic concrete textures")

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

function decodePNG(buf) {
  // verify signature
  let pos = 8
  let w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos); pos += 4
    const type = buf.toString("ascii", pos, pos + 4); pos += 4
    if (type === "IHDR") {
      w = buf.readUInt32BE(pos)
      h = buf.readUInt32BE(pos + 4)
      bitDepth = buf[pos + 8]
      colorType = buf[pos + 9]
      interlace = buf[pos + 12]
    } else if (type === "IDAT") {
      idat.push(buf.subarray(pos, pos + len))
    } else if (type === "IEND") {
      break
    }
    pos += len + 4 // skip data + CRC
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    return { w, h, bitDepth, colorType, interlace, unsupported: true }
  }
  const bpp = colorType === 6 ? 4 : 3
  const stride = w * bpp
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const out = Buffer.alloc(h * stride)
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)]
    const rin = y * (stride + 1) + 1
    const rout = y * stride
    for (let i = 0; i < stride; i++) {
      const x = raw[rin + i]
      const a = i >= bpp ? out[rout + i - bpp] : 0
      const b = y > 0 ? out[rout - stride + i] : 0
      const c = y > 0 && i >= bpp ? out[rout - stride + i - bpp] : 0
      let v
      switch (filter) {
        case 0: v = x; break
        case 1: v = x + a; break
        case 2: v = x + b; break
        case 3: v = x + ((a + b) >> 1); break
        case 4: v = x + paeth(a, b, c); break
        default: v = x
      }
      out[rout + i] = v & 0xff
    }
  }
  return { w, h, bpp, stride, out, colorType }
}

function analyze(dec) {
  const { w, h, bpp, stride, out } = dec
  let n = 0, sumR = 0, sumG = 0, sumB = 0, sumSat = 0, blue = 0, grayish = 0
  const step = 4
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = y * stride + x * bpp
      const r = out[i], g = out[i + 1], b = out[i + 2]
      sumR += r; sumG += g; sumB += b
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
      const sat = mx === 0 ? 0 : (mx - mn) / mx
      sumSat += sat
      if (mx - mn < 16) grayish++
      // normal-map-ish: blue dominant & R,G near mid
      if (b > 150 && b >= r && b >= g && Math.abs(r - 128) < 70 && Math.abs(g - 128) < 70) blue++
      n++
    }
  }
  return {
    meanR: Math.round(sumR / n), meanG: Math.round(sumG / n), meanB: Math.round(sumB / n),
    meanSat: +(sumSat / n).toFixed(3),
    blueFrac: +(blue / n).toFixed(3),
    grayFrac: +(grayish / n).toFixed(3),
  }
}

function classify(a) {
  if (a.blueFrac > 0.6) return "NORMAL map"
  if (a.grayFrac > 0.75 && a.meanSat < 0.06) return "GRAYSCALE data (roughness / AO / height)"
  return "ALBEDO / diffuse (color)"
}

const files = fs.readdirSync(DIR).filter((f) => f.toLowerCase().endsWith(".png")).sort()
const rows = []
for (const f of files) {
  try {
    const dec = decodePNG(fs.readFileSync(path.join(DIR, f)))
    if (dec.unsupported) { rows.push({ f, note: `unsupported ct=${dec.colorType} bd=${dec.bitDepth} il=${dec.interlace}`, w: dec.w, h: dec.h }); continue }
    const a = analyze(dec)
    rows.push({ f, w: dec.w, h: dec.h, ...a, type: classify(a) })
  } catch (e) {
    rows.push({ f, error: String(e) })
  }
}
console.log(JSON.stringify(rows, null, 2))
