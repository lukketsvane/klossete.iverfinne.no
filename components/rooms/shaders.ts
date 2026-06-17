// GLSL shaders for the themed rooms (video CRT, reality-peel, missing-texture,
// the TRON grid). Pure strings shared by the room components.

/* CRT / low-res TV shader for the video screens: chunky pixels, scanlines,
   RGB-subpixel bleed, flicker + static, and a per-screen vignette. */
export const CRT_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
export const CRT_FRAG = /* glsl */ `
  precision mediump float;
  uniform sampler2D map;
  uniform float time;
  uniform vec2 res;        // pixel grid of the "screen"
  uniform float scan;      // scanline depth
  uniform float aberration;
  varying vec2 vUv;

  float rand(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

  void main() {
    // chunky low-res pixels
    vec2 puv = (floor(vUv * res) + 0.5) / res;
    // chromatic aberration – split the channels by a pixel or so
    vec2 off = vec2(aberration) / res;
    float r = texture2D(map, puv + off).r;
    float g = texture2D(map, puv).g;
    float b = texture2D(map, puv - off).b;
    vec3 col = vec3(r, g, b);

    // scanlines + faint vertical aperture grille
    float sl = 0.5 + 0.5 * cos(vUv.y * res.y * 6.2831853);
    col *= 1.0 - scan * (1.0 - sl);
    col *= 1.0 - 0.10 * (0.5 + 0.5 * cos(vUv.x * res.x * 6.2831853));

    // rolling brightness flicker + a little analogue static
    col *= 0.93 + 0.07 * sin(time * 7.0 + vUv.y * 12.0);
    col += (rand(puv + fract(time)) - 0.5) * 0.07;

    // per-screen vignette + a brightened "tube" centre
    vec2 d = vUv - 0.5;
    col *= smoothstep(1.15, 0.25, dot(d, d) * 3.0);

    col = clamp(col * 1.12, 0.0, 1.0);
    // approximate sRGB -> linear so it sits right under the tone-mapping pass
    gl_FragColor = vec4(pow(col, vec3(2.2)), 1.0);
  }
`

/* shared value-noise for the "broken reality" debug rooms */
export const NOISE_GLSL = /* glsl */ `
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i + vec2(0.0,0.0)), hash(i + vec2(1.0,0.0)), u.x),
               mix(hash(i + vec2(0.0,1.0)), hash(i + vec2(1.0,1.0)), u.x), u.y);
  }
  float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i=0;i<4;i++){ s += a*vnoise(p); p *= 2.0; a *= 0.5; } return s; }
`

// 6 — Reality peel: a grid "wallpaper" flakes off in patches, revealing white
// wireframe + grey placeholder material underneath, with a dark curl at the tear.
export const PEEL_FRAG = /* glsl */ `
  precision mediump float;
  varying vec2 vUv;
  uniform float gridScale, peelScale, wireScale, thr;
  ${NOISE_GLSL}
  void main(){
    vec2 uv = vUv;
    // wallpaper: cream paper with blueprint grid lines
    vec2 g = uv * gridScale; vec2 gf = abs(fract(g) - 0.5);
    float minor = smoothstep(0.47, 0.5, max(gf.x, gf.y));
    vec3 paperCol = mix(vec3(0.85,0.83,0.76), vec3(0.46,0.55,0.68), minor);
    // peel mask – where the paper is still attached
    float n = fbm(uv * peelScale);
    float paper = smoothstep(thr - 0.03, thr + 0.06, n);
    // underneath: grey placeholder + white triangle wireframe
    vec2 wg = uv * wireScale; vec2 wf = abs(fract(wg) - 0.5);
    float wl = smoothstep(0.45, 0.5, max(wf.x, wf.y));
    float wd = smoothstep(0.45, 0.5, abs(fract(wg.x + wg.y) - 0.5));
    float wire = max(wl, wd);
    vec3 placeholder = mix(vec3(0.52), vec3(0.97), wire);
    // dark curl shadow right at the tear line
    float curl = smoothstep(0.10, 0.0, abs(n - thr));
    vec3 col = mix(placeholder, paperCol, paper);
    col *= mix(1.0, 0.5, curl);
    gl_FragColor = vec4(pow(col, vec3(2.2)), 1.0);
  }
`

// 7 — Texture not found: patches of neon dev-grid, magenta/black missing-texture
// checker, and real concrete, stitched together by a region mask.
export const MISS_FRAG = /* glsl */ `
  precision mediump float;
  varying vec2 vUv;
  uniform sampler2D concrete;
  uniform float regionScale, neonScale, checkScale, concreteScale;
  ${NOISE_GLSL}
  void main(){
    vec2 uv = vUv;
    float r = fbm(uv * regionScale);
    // neon dev grid
    vec2 ng = uv * neonScale; vec2 nf = abs(fract(ng) - 0.5);
    float nl = smoothstep(0.46, 0.5, max(nf.x, nf.y));
    vec3 neon = mix(vec3(0.015,0.03,0.04), vec3(0.15,1.0,0.7), nl);
    // magenta/black missing-texture checker
    vec2 cg = floor(uv * checkScale); float chk = mod(cg.x + cg.y, 2.0);
    vec3 miss = mix(vec3(0.03), vec3(1.0,0.0,1.0), chk);
    // real concrete
    vec3 conc = texture2D(concrete, uv * concreteScale).rgb;
    vec3 col = r < 0.42 ? neon : (r < 0.68 ? miss : conc);
    gl_FragColor = vec4(pow(col, vec3(2.2)), 1.0);
  }
`

// 8 — The Fourth Side: cold near-black floor with a faint TRON cyan grid.
export const GRID_FRAG = /* glsl */ `
  precision mediump float;
  varying vec2 vUv;
  uniform float scale;
  void main(){
    vec2 g = vUv * scale; vec2 gf = abs(fract(g) - 0.5);
    float line = smoothstep(0.49, 0.5, max(gf.x, gf.y));
    vec2 g2 = vUv * scale * 4.0; vec2 gf2 = abs(fract(g2) - 0.5);
    float sub = smoothstep(0.48, 0.5, max(gf2.x, gf2.y)) * 0.22;
    vec3 col = vec3(0.008, 0.018, 0.03) + vec3(0.0, 0.82, 1.0) * (line + sub);
    gl_FragColor = vec4(pow(col, vec3(2.2)), 1.0);
  }
`
