import test from 'node:test';
import assert from 'node:assert/strict';
import { smoothFilter, snapCubeShader } from '../src/sky/smoothTiles.js';

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
  const out = snapCubeShader(cube);
  assert.match(out, /uv\.z = \(floor\(uv\.z \* meridianDepth\) \+ 0\.5\) \/ meridianDepth/);
  assert.match(out, /textureSize\(tex, 0\)\.z/);
  assert.equal(snapCubeShader(out), out, 'patched once only');
  // 2D tiles and other shaders untouched
  const flat = cube.replace('sampler3D', 'sampler2DArray');
  assert.equal(snapCubeShader(flat), flat);
  assert.equal(snapCubeShader('void main() {}'), 'void main() {}');
});
