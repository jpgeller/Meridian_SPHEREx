import test from 'node:test';
import assert from 'node:assert/strict';
import { smoothFilter, patchCubeShader, HOLE_RIM, FILL_REACH } from '../src/sky/smoothTiles.js';

// WebGL2 constant values (the real enum values)
const C = {
  TEXTURE_2D: 0x0de1,
  TEXTURE_2D_ARRAY: 0x8c1a,
  TEXTURE_3D: 0x806f,
  TEXTURE_MAG_FILTER: 0x2800,
  TEXTURE_MIN_FILTER: 0x2801,
  NEAREST: 0x2600,
  LINEAR: 0x2601,
  NEAREST_MIPMAP_NEAREST: 0x2700,
};

test('smooth tiles: only the magnification filter of tile textures becomes LINEAR', () => {
  assert.equal(smoothFilter(C.TEXTURE_3D, C.TEXTURE_MAG_FILTER, C.NEAREST, C), C.LINEAR);
  assert.equal(smoothFilter(C.TEXTURE_2D_ARRAY, C.TEXTURE_MAG_FILTER, C.NEAREST, C), C.LINEAR);
  // minification unchanged (changing it changed the brightness of wide views)
  assert.equal(smoothFilter(C.TEXTURE_3D, C.TEXTURE_MIN_FILTER, C.NEAREST, C), C.NEAREST);
  assert.equal(smoothFilter(C.TEXTURE_2D_ARRAY, C.TEXTURE_MIN_FILTER, C.NEAREST_MIPMAP_NEAREST, C), C.NEAREST_MIPMAP_NEAREST);
  // other textures (colormaps, overlays) untouched
  assert.equal(smoothFilter(C.TEXTURE_2D, C.TEXTURE_MAG_FILTER, C.NEAREST, C), C.NEAREST);
});

test('smooth tiles: the cube shader samples the centre of its band slice', () => {
  const cube = `#version 300 es
uniform sampler3D tex;
in vec3 frag_uv;
void main() {
    vec3 uv = vec3(frag_uv.xyz);
    vec4 color = uvw2c_ra(uv);
}`;
  const out = patchCubeShader(cube);
  assert.match(out, /uv\.z = \(floor\(uv\.z \* meridianDepth\) \+ 0\.5\) \/ meridianDepth/);
  assert.match(out, /textureSize\(tex, 0\)\.z/);
  assert.equal(patchCubeShader(out), out, 'patched once only');
  // 2D tiles and other shaders untouched
  const flat = cube.replace('sampler3D', 'sampler2DArray');
  assert.equal(patchCubeShader(flat), flat);
  assert.equal(patchCubeShader('void main() {}'), 'void main() {}');
});

// Aladin's real cube shader ends like this (grey tiles: uvw2c_ra; captured from aladin-lite 3.8.2)
const ALADIN_CUBE = `#version 300 es
precision lowp float;
uniform sampler3D tex;
in vec3 frag_uv;
vec4 uvw2c_ra(vec3 uv) {
    vec2 c = texture(tex, uv).rg;
    return vec4(c.r, c.r, c.r, c.g);
}
void main() {
    vec3 uv = vec3(frag_uv.xyz);
    vec4 color = uvw2c_ra(uv);
    out_frag_color = color;
}`;

test('smooth tiles: grey cube tiles are drawn by the hole-filling cubic sampler', () => {
  const out = patchCubeShader(ALADIN_CUBE);
  assert.match(out, /vec4 color = meridian_ra\(uv\);/);
  assert.doesNotMatch(out, /vec4 color = uvw2c_ra\(uv\);/);
  assert.ok(out.indexOf('vec4 meridian_ra(') < out.indexOf('void main()'), 'helpers defined before main');
  assert.match(out, /uv\.z = \(floor/, 'band still snapped');
  // constants are baked in as GLSL
  assert.match(out, new RegExp(`s <= ${FILL_REACH};`));
  assert.match(out, new RegExp(`MERIDIAN_HOLE_RIM = ${HOLE_RIM.toFixed(3)};`));
  assert.doesNotMatch(out, /\$\{/, 'no unreplaced template');
  // zoomed out keeps Aladin's own sampling; zoomed in uses the 4x4 B-spline
  assert.match(out, /fwidth\(pos\)/);
  assert.match(out, /texture\(tex, uv\)\.rg/);
  assert.equal(patchCubeShader(out), out, 'patched once only');
});

test('smooth tiles: B-spline weights in the shader sum to 1 and are never negative', () => {
  // the same formula as meridian_weights, evaluated in JS
  const w = (f) => { const g = 1 - f; return [g ** 3, 3 * f ** 3 - 6 * f ** 2 + 4, -3 * f ** 3 + 3 * f ** 2 + 3 * f + 1, f ** 3].map((x) => x / 6); };
  for (const f of [0, 0.1, 0.25, 0.5, 0.75, 0.99]) {
    const ws = w(f);
    assert.ok(Math.abs(ws.reduce((a, b) => a + b) - 1) < 1e-12);
    assert.ok(ws.every((x) => x >= 0));
  }
  assert.match(patchCubeShader(ALADIN_CUBE), /-3\.0 \* f3 \+ 3\.0 \* f2 \+ 3\.0 \* f \+ 1\.0/);
});
