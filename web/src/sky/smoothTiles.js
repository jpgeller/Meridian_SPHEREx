// Smooth sky tiles: soft, round stars at deep zoom instead of hard squares with black centres.
//
// The SPHEREx HiPS cube stops at order 5 (12.9″ per pixel), and Aladin Lite 3.8.2 hard-codes NEAREST
// filtering for its tile textures (Rust: hips/d2/buffer.rs, hips/d3/texture.rs), so a zoomed sky looks
// blocky. Aladin's WebGL calls go through the browser's WebGL2RenderingContext, so before Aladin starts:
//
//  1. Magnification filter NEAREST -> LINEAR for tile textures (2D arrays: plain HiPS such as the colour
//     mixes; 3D: the SPHEREx cube, one RG8 texture of 32 band slices per tile).
//  2. The cube's fragment shader is rewritten (see CUBE_FNS):
//     - Blank pixels are filled. IRSA's tiles store saturated star cores and masked pixels as palette
//       index 0 (transparent black), so every bright star had a black hole in its centre (Betelgeuse a
//       black disc). A zero pixel enclosed by bright pixels now takes the distance-weighted mean of the
//       nearest non-zero pixels in 8 directions (up to FILL_REACH pixels away; see HOLE_RIM). Holes are
//       rare (~0.1–0.6% of a tile). Display only: the 2D view and the API use the real images.
//     - Zoomed in (one tile pixel larger than a screen pixel), the image is drawn with a cubic B-spline
//       through 4×4 pixels instead of bilinear: stars come out as round soft spots, not diamonds or squares.
//       It adds no detail and softens a little (σ ≈ 0.6 px); it hides the pixel grid. Mean brightness is
//       unchanged (measured 42.0 → 42.0 on a faint field at 2.5°).
//     - Zoomed out, Aladin's own sampling is kept (changing it changed the brightness of wide views).
//     - The band coordinate is snapped to the centre of its slice. Without this, LINEAR on a 3D texture also
//       blends a band with its neighbour band (measured: blacks lifted to grey, mean brightness +13% at 2.3°).
//
// Must run before Aladin creates its WebGL context (main.js imports it first). Off with ?smooth=0.

const GL = typeof WebGL2RenderingContext !== 'undefined' ? WebGL2RenderingContext : null;

/** How far (tile pixels) a zero pixel looks for its rim. Betelgeuse's hole (joined to a ghost ring) is ~70 px long. */
export const FILL_REACH = 48;
/** Directions allowed to find no rim within reach (long thin holes, such as a hole joined to a ghost ring). */
export const OPEN_DIRS = 2;
/**
 * IRSA's palette draws blanks AND the darkest sky as 0 (index 0 transparent, index 1 opaque black; Aladin's
 * texture keeps no alpha). The sky floor just above 0 is ~0.14 (palette index ~36). So a 0 is a hole only
 * if it is enclosed: in each of 8 directions the first non-zero pixel is brighter than HOLE_RIM (star glare,
 * measured ~0.45–0.7 round holes; up to OPEN_DIRS directions may find nothing within FILL_REACH). Zeros in dark sky meet the 0.14 floor, or nothing, and stay black;
 * a looser test (mean of the rim) drew streaks from distant stars across dark fields like R Dra's.
 */
export const HOLE_RIM = 0.2;

/** The filter to use instead of `value` for a tile texture (pure, for tests). */
export function smoothFilter(target, pname, value, C) {
  if (target !== C.TEXTURE_2D_ARRAY && target !== C.TEXTURE_3D) return value;
  if (pname === C.TEXTURE_MAG_FILTER && value === C.NEAREST) return C.LINEAR;
  return value;
}

const UV_LINE = 'vec3 uv = vec3(frag_uv.xyz);';
const SNAP = `${UV_LINE}\n    { float meridianDepth = float(textureSize(tex, 0).z); uv.z = (floor(uv.z * meridianDepth) + 0.5) / meridianDepth; }`;
const RA_CALL = 'vec4 color = uvw2c_ra(uv);';
const MAIN = 'void main()';

// GLSL ES 3.00. The tile shader declares `precision lowp float`, so every coordinate is highp.
const CUBE_FNS = `
// ---- Meridian: smooth tiles (web/src/sky/smoothTiles.js) ----
const ivec2 MERIDIAN_DIRS[8] = ivec2[8](ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1),
                                        ivec2(1, 1), ivec2(-1, 1), ivec2(1, -1), ivec2(-1, -1));

const highp float MERIDIAN_BLANK = 0.5 / 255.0;
const highp float MERIDIAN_HOLE_RIM = ${HOLE_RIM.toFixed(3)};

// One tile pixel (r, g). A hole (a zero pixel whose first non-zero pixel in each of 8 directions is
// brighter than MERIDIAN_HOLE_RIM; directions that leave the tile are skipped, ${OPEN_DIRS} may find nothing)
// takes the distance-weighted mean of those pixels. Any other zero pixel stays black, as Aladin draws it.
highp vec2 meridian_texel(ivec3 p, ivec2 size) {
  p.xy = clamp(p.xy, ivec2(0), size - 1);
  highp vec2 t = texelFetch(tex, p, 0).rg;
  if (t.g > MERIDIAN_BLANK) return t;
  highp vec2 sum = vec2(0.0);
  highp float wsum = 0.0;
  int open_dirs = 0;
  for (int d = 0; d < 8; d++) {
    ivec2 dir = MERIDIAN_DIRS[d];
    highp float step_len = (d < 4) ? 1.0 : 1.41421;
    bool hit = false;
    bool left_tile = false;
    for (int s = 1; s <= ${FILL_REACH}; s++) {
      ivec2 q = p.xy + dir * s;
      if (any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, size))) { left_tile = true; break; }
      highp vec2 v = texelFetch(tex, ivec3(q, p.z), 0).rg;
      if (v.g > MERIDIAN_BLANK) {
        if (v.r < MERIDIAN_HOLE_RIM) return t; // dark rim: black sky, not a hole
        highp float w = 1.0 / (float(s) * step_len);
        sum += v * w;
        wsum += w;
        hit = true;
        break;
      }
    }
    if (!hit && !left_tile && ++open_dirs > ${OPEN_DIRS}) return t; // open: no rim within reach
  }
  return wsum > 0.0 ? sum / wsum : t;
}

// Cubic B-spline weights for offsets -1, 0, 1, 2 at fraction f. Smoothest of the cubics (no negative
// lobes, so no dark ring round bright stars); compared with Mitchell (B = C = 1/3) it hides the pixel grid
// of noisy faint sky much better.
highp vec4 meridian_weights(highp float f) {
  highp float g = 1.0 - f;
  highp float f2 = f * f;
  highp float f3 = f2 * f;
  return vec4(g * g * g, 3.0 * f3 - 6.0 * f2 + 4.0, -3.0 * f3 + 3.0 * f2 + 3.0 * f + 1.0, f3) / 6.0;
}

// The tile's (r, g) at uv, holes filled.
highp vec2 meridian_sample(vec3 uv) {
  ivec3 size = textureSize(tex, 0);
  highp vec2 pos = uv.xy * vec2(size.xy);
  highp vec2 footprint = fwidth(pos); // tile pixels per screen pixel
  int z = clamp(int(uv.z * float(size.z)), 0, size.z - 1);
  if (max(footprint.x, footprint.y) >= 1.0) {
    // zoomed out: Aladin's own sampling, with blank pixels filled
    highp vec2 c = texture(tex, uv).rg;
    return c.g > MERIDIAN_BLANK ? c : meridian_texel(ivec3(ivec2(floor(pos)), z), size.xy);
  }
  // zoomed in: cubic B-spline through the 4x4 nearest pixels
  highp vec2 coord = pos - 0.5;
  ivec2 base = ivec2(floor(coord));
  highp vec2 f = coord - floor(coord);
  highp vec4 wx = meridian_weights(f.x);
  highp vec4 wy = meridian_weights(f.y);
  highp vec2 sum = vec2(0.0);
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      sum += wx[i] * wy[j] * meridian_texel(ivec3(base + ivec2(i - 1, j - 1), z), size.xy);
    }
  }
  return clamp(sum, 0.0, 1.0);
}

// Aladin's uvw2c_ra, reading meridian_sample instead of texture().
vec4 meridian_ra(vec3 uv) {
  vec2 c = meridian_sample(uv);
  c.r = transfer_func(H, c.r, min_value, max_value);
  c.r = mix(c.r, 1.0 - c.r, reversed);
  vec3 color = colormap_f(c.r).rgb;
  return apply_tonal(vec4(color, c.g));
}
// ---- end Meridian ----
`;

/**
 * Aladin's cube (sampler3D) fragment shader with the band coordinate snapped to a slice centre and, for
 * grey tiles drawn with uvw2c_ra (the SPHEREx cube), holes filled and B-spline sampling when zoomed in (pure).
 */
export function patchCubeShader(src) {
  if (typeof src !== 'string' || !/uniform\s+sampler3D\s+tex\s*;/.test(src) || !src.includes(UV_LINE) || src.includes('meridianDepth')) {
    return src;
  }
  let out = src.replace(UV_LINE, SNAP);
  if (out.includes(RA_CALL) && out.includes(MAIN) && out.includes('vec4 uvw2c_ra(')) {
    out = out.replace(MAIN, `${CUBE_FNS}\n${MAIN}`).replace(RA_CALL, 'vec4 color = meridian_ra(uv);');
  }
  return out;
}

export function installSmoothTiles({ enabled = true } = {}) {
  if (!GL || !enabled || GL.prototype.__meridianSmooth) return false;
  const proto = GL.prototype;
  const texParameteri = proto.texParameteri;
  proto.texParameteri = function (target, pname, value) {
    return texParameteri.call(this, target, pname, smoothFilter(target, pname, value, GL));
  };
  const shaderSource = proto.shaderSource;
  proto.shaderSource = function (shader, src) {
    return shaderSource.call(this, shader, patchCubeShader(src));
  };
  proto.__meridianSmooth = true;
  return true;
}

const off = typeof location !== 'undefined' && new URLSearchParams(location.search).get('smooth') === '0';
export const SMOOTH_TILES = installSmoothTiles({ enabled: !off });
