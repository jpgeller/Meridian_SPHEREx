// Smooth sky tiles: blend neighbouring HiPS pixels instead of drawing each as a hard square.
//
// The SPHEREx HiPS cube stops at order 5 (12.9″ per pixel), and Aladin Lite 3.8.2 hard-codes NEAREST
// filtering for its tile textures (Rust: hips/d2/buffer.rs, hips/d3/texture.rs), so a zoomed sky looks
// blocky. Aladin's WebGL calls go through the browser's WebGL2RenderingContext, so before Aladin starts:
//
//  1. Magnification filter NEAREST -> LINEAR for tile textures (2D arrays: plain HiPS such as the colour
//     mixes; 3D: the SPHEREx cube, one RG8 texture of 32 band slices per tile). The GPU then interpolates
//     between pixel centres (bilinear) on the whole sky alike. It adds no detail; it hides the pixel grid.
//  2. In the cube shaders, the band coordinate is snapped to the centre of its slice. Without this, LINEAR
//     on a 3D texture also blends a band with its neighbour band (measured: blacks lifted to grey, mean
//     brightness +13% at 2.3°). Snapped, each band stays exactly the band NEAREST would have picked.
//
// Minification is left alone (wide views were already smooth, and changing it changed their brightness).
// Must run before Aladin creates its WebGL context (main.js imports it first). Off with ?smooth=0.

const GL = typeof WebGL2RenderingContext !== 'undefined' ? WebGL2RenderingContext : null;

/** The filter to use instead of `value` for a tile texture (pure, for tests). */
export function smoothFilter(target, pname, value, C) {
  if (target !== C.TEXTURE_2D_ARRAY && target !== C.TEXTURE_3D) return value;
  if (pname === C.TEXTURE_MAG_FILTER && value === C.NEAREST) return C.LINEAR;
  return value;
}

const UV_LINE = 'vec3 uv = vec3(frag_uv.xyz);';
const SNAP = `${UV_LINE}\n    { float meridianDepth = float(textureSize(tex, 0).z); uv.z = (floor(uv.z * meridianDepth) + 0.5) / meridianDepth; }`;

/** Aladin's cube (sampler3D) fragment shader with the band coordinate snapped to a slice centre (pure). */
export function snapCubeShader(src) {
  if (typeof src !== 'string' || !/uniform\s+sampler3D\s+tex\s*;/.test(src) || !src.includes(UV_LINE) || src.includes('meridianDepth')) {
    return src;
  }
  return src.replace(UV_LINE, SNAP);
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
    return shaderSource.call(this, shader, snapCubeShader(src));
  };
  proto.__meridianSmooth = true;
  return true;
}

const off = typeof location !== 'undefined' && new URLSearchParams(location.search).get('smooth') === '0';
export const SMOOTH_TILES = installSmoothTiles({ enabled: !off });
