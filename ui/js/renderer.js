// WebGL2 renderer for FFXI entity models. Skinning runs on the GPU: the vertex
// shader rotates pre-weighted joint-local positions by per-joint pose
// quaternions (same math as the verified CPU path in pose.js).

import { OrbitCamera, mat4Multiply } from './camera.js';
import { SkeletonPose } from './pose.js';
import { ParticleDrawer } from './particleDrawer.js';
import { Vec3 } from './particle/math.js';

const MAX_JOINTS = 160;

const VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location=0) in vec3 aP0;
layout(location=1) in vec3 aP1;
layout(location=2) in vec3 aN0;
layout(location=3) in vec3 aN1;
layout(location=4) in vec2 aWeights;
layout(location=5) in vec2 aJoints;
layout(location=6) in vec2 aUV;
layout(location=7) in vec4 aColor;

uniform mat4 uViewProj;
uniform vec4 uRot[${MAX_JOINTS}];
uniform vec4 uTrans[${MAX_JOINTS}];
uniform vec4 uScale[${MAX_JOINTS}];

out vec2 vUV;
out vec4 vColor;
out vec3 vNormal;
out vec3 vWorld;

vec3 qrot(vec4 q, vec3 v) {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

void main() {
  int j0 = int(aJoints.x);
  int j1 = int(aJoints.y);

  // Positions are pre-weighted; weights scale only the bone translations.
  // Single-jointed vertices have p1 = n1 = 0 and weights (1, 0), so the
  // unified expression reduces to the single-joint formula.
  vec3 world = qrot(uRot[j0], uScale[j0].xyz * aP0) + aWeights.x * uTrans[j0].xyz
             + qrot(uRot[j1], uScale[j1].xyz * aP1) + aWeights.y * uTrans[j1].xyz;

  vNormal = aWeights.x * qrot(uRot[j0], aN0) + aWeights.y * qrot(uRot[j1], aN1);
  vUV = aUV;
  vColor = aColor;
  vWorld = world;
  gl_Position = uViewProj * vec4(world, 1.0);
}
`;

// Shared fog snippet: mixes toward uFogColor by camera distance.
const FOG_UNIFORMS = `
uniform vec3 uCameraPos;
uniform vec3 uFogColor;
uniform vec2 uFogRange;   // (near, far); far <= 0 disables fog
`;
const FOG_APPLY = `
  if (uFogRange.y > 0.0) {
    float d = length(vWorld - uCameraPos);
    float f = clamp((d - uFogRange.x) / max(uFogRange.y - uFogRange.x, 0.001), 0.0, 1.0);
    outColor.rgb = mix(outColor.rgb, uFogColor, f);
  }
`;

// uAlphaMode: 0 = entity (two-pass cutout/blend), 1 = zone opaque (ignore tex alpha),
//             2 = zone cutout (_-prefix foliage), 3 = zone blend (water/fog 0x8000)
// uTerrainLit: 1 = xim terrain lighting (ambient + sun + moon), 0 = entity key-light
const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 vUV;
in vec4 vColor;
in vec3 vNormal;
in vec3 vWorld;

uniform sampler2D uTexture;
uniform vec3 uLightDir;
uniform int uAlphaPass;   // 0 = opaque pass (solids), 1 = transparent pass (blended)
uniform float uShowAlpha; // 1 = blend/cutout alpha, 0 = force fully opaque
uniform int uAlphaMode;   // see comment above
uniform float uTerrainLit; // 1 = zone terrain (xim), 0 = entity
uniform vec3 uAmbient;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uMoonDir;
uniform vec3 uMoonColor;
${FOG_UNIFORMS}

out vec4 outColor;

void main() {
  vec4 tex = texture(uTexture, vUV);

  // FFXI alpha: 4 * vertexColorAlpha * textureAlpha. Neutral vColor.a is
  // 0x80 (0.5), so this is 2*texAlpha when diffuse alpha is untouched. (xim)
  float rawAlpha = clamp(4.0 * vColor.a * tex.a, 0.0, 1.0);

  float alpha;
  if (uShowAlpha < 0.5) {
    alpha = 1.0;
  } else if (uAlphaMode == 1) {
    // Zone opaque: retail ignores texture alpha on non-blend submeshes.
    alpha = 1.0;
  } else if (uAlphaMode == 2) {
    // Zone cutout foliage (mesh name starts with '_'): hard alpha-test.
    alpha = rawAlpha;
    if (alpha < 0.375) discard;
  } else if (uAlphaMode == 3) {
    // Zone soft-edge / water blend (xim): vertex alpha fades tile edges.
    alpha = rawAlpha;
    if (alpha < 0.02) discard;
  } else {
    // Entity default: two-pass solid/translucent split.
    alpha = rawAlpha;
    if (alpha < 0.06) discard;
    if (uAlphaPass == 0 && alpha < 0.5) discard;
    if (uAlphaPass == 1 && alpha >= 0.5) discard;
  }

  vec3 litRgb;
  if (uTerrainLit > 0.5) {
    // XimShader terrain path: lit = vColor*ambient + Σ vColor*N·L*lightColor
    // then modulate2x with texture. No camera key-light.
    vec3 n = vNormal;
    float nl = length(n);
    n = nl > 1e-4 ? n / nl : vec3(0.0, 1.0, 0.0);
    vec3 amb = vColor.rgb * uAmbient;
    vec3 df0 = vColor.rgb * clamp(dot(n, uSunDir),  0.0, 1.0) * uSunColor;
    vec3 df1 = vColor.rgb * clamp(dot(n, uMoonDir), 0.0, 1.0) * uMoonColor;
    litRgb = clamp(amb + df0 + df1, 0.0, 1.0);
  } else {
    // Entity: camera-relative key light (legacy).
    float nl = length(vNormal);
    float intensity = nl < 1e-3 ? 1.0
      : 0.55 + 0.6 * max(0.0, dot(vNormal / nl, -uLightDir));
    litRgb = vColor.rgb * intensity;
  }

  // modulate2x: 2 * lit * tex (0x80 diffuse neutral)
  outColor = vec4(tex.rgb * litRgb * 2.0, alpha);
${FOG_APPLY}
}
`;

// --- Zone terrain (port of xim XimShader: no skinning, wind position blend) ---
// Geometry arrives pre-baked in display space, so the VS only applies the wind
// blend (position0 + windFactor * position1) and the view-projection.
const ZONE_VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location=0) in vec3 aP0;
layout(location=1) in vec3 aP1;      // wind blend delta (0 when the submesh has none)
layout(location=2) in vec3 aN;
layout(location=3) in vec2 aUV;
layout(location=4) in vec4 aColor;

uniform mat4 uViewProj;
uniform float uWind;                 // positionBlendWeight (xim WindFactor)
uniform vec3 uCenter;                // sky meshes follow the camera; 0 for world geometry
uniform vec2 uUVOffset;              // cloud / effect UV drift

out vec2 vUV;
out vec4 vColor;
out vec3 vNormal;
out vec3 vWorld;

void main() {
  vec3 world = aP0 + uWind * aP1 + uCenter;
  vUV = aUV + uUVOffset;
  vColor = aColor;
  vNormal = aN;
  vWorld = world;
  gl_Position = uViewProj * vec4(world, 1.0);
}
`;

// XimShader.fragShader:
//   lit    = clamp(vColor*ambient + Σ vColor*max(0, N·L)*lightColor, 0, 1), a = vColor.a
//   pixel  = vec4(2*lit.rgb*tex.rgb, 4*lit.a*tex.a)
//   discard when pixel.a < discardThreshold, then fog (fog preserves alpha)
const ZONE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 vUV;
in vec4 vColor;
in vec3 vNormal;
in vec3 vWorld;

uniform sampler2D uTexture;
uniform float uDiscard;    // 0.375 for '_' meshes, else 0
uniform float uShowAlpha;  // 0 = force opaque (viewer toggle)
uniform vec3 uAmbient;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uMoonDir;
uniform vec3 uMoonColor;
${FOG_UNIFORMS}

out vec4 outColor;

void main() {
  vec4 tex = texture(uTexture, vUV);

  vec3 n = vNormal;
  float nl = length(n);
  n = nl > 1e-4 ? n / nl : vec3(0.0, 1.0, 0.0);
  vec3 amb = vColor.rgb * uAmbient;
  vec3 df0 = vColor.rgb * clamp(dot(n, uSunDir),  0.0, 1.0) * uSunColor;
  vec3 df1 = vColor.rgb * clamp(dot(n, uMoonDir), 0.0, 1.0) * uMoonColor;
  vec3 lit = clamp(amb + df0 + df1, 0.0, 1.0);

  float alpha = 4.0 * vColor.a * tex.a;
  if (alpha < uDiscard) discard;
  outColor = vec4(2.0 * lit * tex.rgb, uShowAlpha > 0.5 ? clamp(alpha, 0.0, 1.0) : 1.0);
${FOG_APPLY}
}
`;

// --- Floor plane (tiled ground texture + fog) ------------------------------

const FLOOR_VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;   // world X/Z on the Y=0 plane
uniform mat4 uViewProj;
uniform float uTile;               // texture repeats per world unit
uniform float uY;                  // floor height (model feet)
out vec2 vUV;
out vec3 vWorld;
void main() {
  vWorld = vec3(aPos.x, uY, aPos.y);
  vUV = aPos * uTile;
  gl_Position = uViewProj * vec4(vWorld, 1.0);
}
`;

const FLOOR_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 vUV;
in vec3 vWorld;
uniform sampler2D uTexture;
${FOG_UNIFORMS}
out vec4 outColor;
void main() {
  outColor = vec4(texture(uTexture, vUV).rgb, 1.0);
${FOG_APPLY}
}
`;

// --- Debug overlays: collision (per-vert colour) + navmesh (solid green) ----

const OVERLAY_VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aColor;
uniform mat4 uViewProj;
out vec3 vColor;
void main() {
  vColor = aColor;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}
`;

const OVERLAY_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 vColor;
uniform float uOpacity;
out vec4 outColor;
void main() {
  outColor = vec4(vColor, uOpacity);
}
`;

// --- Sky dome (xim SkyBoxMesh): vertex-coloured gradient dome, camera-centred,
// unlit, drawn behind everything. uCenter follows the eye so it wraps the free
// camera (xim leaves it at the world origin; zones are authored around it). ----

const SKY_VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;      // dome-local position (display space)
layout(location=1) in vec4 aColor;
uniform mat4 uViewProj;
uniform vec3 uCenter;
out vec4 vColor;
void main() {
  vColor = aColor;
  gl_Position = uViewProj * vec4(aPos + uCenter, 1.0);
}
`;

const SKY_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 outColor;
void main() { outColor = vec4(vColor.rgb, 1.0); }
`;

/** Edge index list for wireframe drawElements(LINES). */
function buildWireIndices(vertCount, isStrip) {
  if (vertCount < 3) return null;
  const edges = [];
  const push = (a, b) => { edges.push(a, b); };
  if (!isStrip) {
    for (let i = 0; i + 2 < vertCount; i += 3) {
      push(i, i + 1); push(i + 1, i + 2); push(i + 2, i);
    }
  } else {
    for (let i = 0; i + 2 < vertCount; i++) {
      push(i, i + 1); push(i + 1, i + 2); push(i + 2, i);
    }
  }
  return edges.length ? new Uint32Array(edges) : null;
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;

    this.s3tc = gl.getExtension('WEBGL_compressed_texture_s3tc');

    this.program = buildProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    this.uniforms = {
      viewProj: gl.getUniformLocation(this.program, 'uViewProj'),
      rot: gl.getUniformLocation(this.program, 'uRot'),
      trans: gl.getUniformLocation(this.program, 'uTrans'),
      scale: gl.getUniformLocation(this.program, 'uScale'),
      texture: gl.getUniformLocation(this.program, 'uTexture'),
      lightDir: gl.getUniformLocation(this.program, 'uLightDir'),
      cameraPos: gl.getUniformLocation(this.program, 'uCameraPos'),
      fogColor: gl.getUniformLocation(this.program, 'uFogColor'),
      fogRange: gl.getUniformLocation(this.program, 'uFogRange'),
      alphaPass: gl.getUniformLocation(this.program, 'uAlphaPass'),
      showAlpha: gl.getUniformLocation(this.program, 'uShowAlpha'),
      alphaMode: gl.getUniformLocation(this.program, 'uAlphaMode'),
      terrainLit: gl.getUniformLocation(this.program, 'uTerrainLit'),
      ambient: gl.getUniformLocation(this.program, 'uAmbient'),
      sunDir: gl.getUniformLocation(this.program, 'uSunDir'),
      sunColor: gl.getUniformLocation(this.program, 'uSunColor'),
      moonDir: gl.getUniformLocation(this.program, 'uMoonDir'),
      moonColor: gl.getUniformLocation(this.program, 'uMoonColor'),
    };
    // Default midday outdoor terrain lighting (overwritten per-zone from 0x2F).
    this.terrainLighting = {
      ambient: [0.45, 0.45, 0.45],
      sunDir: [0.35, 0.9, 0.25],
      sunColor: [0.55, 0.55, 0.5],
      moonDir: [-0.35, -0.9, -0.25],
      moonColor: [0.08, 0.08, 0.12],
      fogColor: [0.5, 0.55, 0.6],
      fogNear: 80,
      fogFar: 400,
      fogOn: false,
      clearColor: null,
      indoors: false,
    };
    // View > Unlit forces full unlit; lightBrightness (0..1) blends default → unlit.
    this.unlit = false;
    this.lightBrightness = 0;
    this.polygonMode = gl.getExtension('WEBGL_polygon_mode');

    // Zone terrain program (xim ximProgram equivalent).
    this.zoneProgram = buildProgram(gl, ZONE_VERTEX_SHADER, ZONE_FRAGMENT_SHADER);
    this.zoneUniforms = {
      viewProj: gl.getUniformLocation(this.zoneProgram, 'uViewProj'),
      wind: gl.getUniformLocation(this.zoneProgram, 'uWind'),
      center: gl.getUniformLocation(this.zoneProgram, 'uCenter'),
      texture: gl.getUniformLocation(this.zoneProgram, 'uTexture'),
      discard: gl.getUniformLocation(this.zoneProgram, 'uDiscard'),
      showAlpha: gl.getUniformLocation(this.zoneProgram, 'uShowAlpha'),
      ambient: gl.getUniformLocation(this.zoneProgram, 'uAmbient'),
      sunDir: gl.getUniformLocation(this.zoneProgram, 'uSunDir'),
      sunColor: gl.getUniformLocation(this.zoneProgram, 'uSunColor'),
      moonDir: gl.getUniformLocation(this.zoneProgram, 'uMoonDir'),
      moonColor: gl.getUniformLocation(this.zoneProgram, 'uMoonColor'),
      cameraPos: gl.getUniformLocation(this.zoneProgram, 'uCameraPos'),
      fogColor: gl.getUniformLocation(this.zoneProgram, 'uFogColor'),
      fogRange: gl.getUniformLocation(this.zoneProgram, 'uFogRange'),
      uvOffset: gl.getUniformLocation(this.zoneProgram, 'uUVOffset'),
    };
    this.zoneBatches = [];
    this.zoneDisableCull = false;   // debug: ignore the per-submesh cull flag
    // xim WindFactor: a 0→1→0 triangle wave, 2 seconds per leg.
    this.windFactor = 0;
    this.windDir = 1;

    // Floor plane program + a unit quad spanning [-1,1] (scaled in the shader).
    this.floorProgram = buildProgram(gl, FLOOR_VERTEX_SHADER, FLOOR_FRAGMENT_SHADER);
    this.floorUniforms = {
      viewProj: gl.getUniformLocation(this.floorProgram, 'uViewProj'),
      texture: gl.getUniformLocation(this.floorProgram, 'uTexture'),
      tile: gl.getUniformLocation(this.floorProgram, 'uTile'),
      y: gl.getUniformLocation(this.floorProgram, 'uY'),
      cameraPos: gl.getUniformLocation(this.floorProgram, 'uCameraPos'),
      fogColor: gl.getUniformLocation(this.floorProgram, 'uFogColor'),
      fogRange: gl.getUniformLocation(this.floorProgram, 'uFogRange'),
    };
    const half = 60;
    this.floorVao = gl.createVertexArray();
    this.floorVbo = gl.createBuffer();
    gl.bindVertexArray(this.floorVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.floorVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -half, -half, half, -half, half, half, -half, -half, half, half, -half, half,
    ]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.floor = null;      // { texture } when a floor is loaded
    this.floorY = 0;
    this.floorTile = 0.5;
    // `_fogBase` is the authored fog (zone environment or manual); `fog` is what
    // the shaders read after the user's toggle and distance scale are applied.
    this._fogBase = { enabled: false, color: [0x30 / 255, 0x34 / 255, 0x38 / 255], near: 6, far: 40 };
    this.fogOverride = { enabled: true, scale: 1 };
    this.fog = { ...this._fogBase };

    // Collision / navmesh debug overlays (zone only).
    this.overlayProgram = buildProgram(gl, OVERLAY_VERTEX_SHADER, OVERLAY_FRAGMENT_SHADER);
    this.overlayUniforms = {
      viewProj: gl.getUniformLocation(this.overlayProgram, 'uViewProj'),
      opacity: gl.getUniformLocation(this.overlayProgram, 'uOpacity'),
    };
    // Sky dome program (xim SkyBoxMesh). Built per-zone from the 0x2F skybox.
    this.skyProgram = buildProgram(gl, SKY_VERTEX_SHADER, SKY_FRAGMENT_SHADER);
    this.skyUniforms = {
      viewProj: gl.getUniformLocation(this.skyProgram, 'uViewProj'),
      center: gl.getUniformLocation(this.skyProgram, 'uCenter'),
    };
    this.skyDome = null;   // { vao, vbo, count } | null
    this.skyWeather = null; // current weather id — which cloud layer to show

    this.collisionOverlay = null; // { vao, vbo, count }
    this.navmeshOverlay = null;
    this.showCollision = false;
    this.showNavmesh = false;
    this.showSkybox = false;
    this.collisionOpacity = 0.45;
    this.navmeshOpacity = 0.40;

    this.whiteTexture = makeWhiteTexture(gl);
    this.camera = new OrbitCamera();

    this.model = null;
    this.pose = null;
    this.batches = [];
    this.textures = new Map();

    this.rotArray = new Float32Array(MAX_JOINTS * 4);
    this.transArray = new Float32Array(MAX_JOINTS * 4);
    this.scaleArray = new Float32Array(MAX_JOINTS * 4);

    this.currentAnimation = null;
    this.animFrame = 0;
    this.playing = false;
    this.showTextures = true;
    this.showWireframe = false;
    this.showAlpha = true;
    this.poseDirty = true;

    // Horizontal screen-space shift in CSS px (positive = scene moves right).
    // Used to keep the model centered in the area not covered by the tree panel.
    this.screenOffsetX = 0;

    this.clearColor = [0x30 / 255, 0x34 / 255, 0x38 / 255];
    this.userClearColor = this.clearColor.slice();
  }

  /** Accepts '#rrggbb'. */
  setClearColor(hex) {
    const rgb = hexToRgb(hex);
    if (rgb) {
      this.userClearColor = rgb;
      this.clearColor = rgb;
    }
  }

  /** Sets the floor's tiled ground texture (a parsed floor TextureImage), or null. */
  setFloorTexture(image) {
    const gl = this.gl;
    if (this.floor) { gl.deleteTexture(this.floor.texture); this.floor = null; }
    if (!image) return;
    const texture = this.createTexture(image);
    if (texture) {
      // Tile roughly every ~2 world units regardless of the source resolution.
      this.floorTile = 1 / 2;
      this.floor = { texture };
      this.snapFloorToFeet();
    }
  }

  /**
   * Scene fog, { enabled, color:'#rrggbb', near, far } — any subset.
   *
   * The values given here are the *source* fog: for a zone that's whatever the
   * 0x2F environment authored (re-pushed every frame during a weather fade), for
   * an entity it's the manual viewer fog. The user's toggle and distance scale
   * are stored separately and re-applied on top, so an incoming environment
   * update can't stomp them.
   */
  setFog(opts = {}) {
    const base = this._fogBase;
    if (opts.enabled !== undefined) base.enabled = opts.enabled;
    if (opts.color) {
      if (Array.isArray(opts.color)) base.color = opts.color;
      else { const rgb = hexToRgb(opts.color); if (rgb) base.color = rgb; }
    }
    if (opts.near !== undefined) base.near = opts.near;
    if (opts.far !== undefined) base.far = opts.far;
    this._applyFog();
  }

  /** User override: { enabled, scale } — scale multiplies the authored distance. */
  setFogOverride({ enabled, scale } = {}) {
    if (enabled !== undefined) this.fogOverride.enabled = enabled;
    if (scale !== undefined) this.fogOverride.scale = scale;
    this._applyFog();
  }

  _applyFog() {
    const base = this._fogBase;
    const scale = this.fogOverride.scale ?? 1;
    this.fog.enabled = base.enabled && this.fogOverride.enabled !== false;
    this.fog.color = base.color;
    this.fog.near = base.near * scale;
    this.fog.far = base.far * scale;
  }

  /** Apply xim-style terrain lighting (from zone 0x2F environment). */
  setTerrainLighting(lit) {
    if (!lit) return;
    this.terrainLighting = { ...this.terrainLighting, ...lit };
    // Always sync fog from the environment (disable when the DAT has none).
    this.setFog({
      enabled: !!lit.fogOn,
      color: lit.fogColor,
      near: lit.fogNear ?? 0,
      far: lit.fogFar ?? 0,
    });
    // Indoor clear colour from the DAT; outdoors restore the user/settings colour.
    if (lit.clearColor) this.clearColor = lit.clearColor;
    else if (this.userClearColor) this.clearColor = this.userClearColor;
  }

  /**
   * Zone lighting uniforms. Blends terrain env lighting toward unlit
   * (ambient white, no sun/moon) by lightBrightness 0..1. View > Unlit = 1.
   */
  _zoneLightUniforms() {
    const L = this.terrainLighting;
    const t = this.unlit ? 1 : Math.min(1, Math.max(0, this.lightBrightness || 0));
    if (t <= 0) return L;
    const lerp3 = (a, b) => [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ];
    return {
      ambient: lerp3(L.ambient, [1, 1, 1]),
      sunDir: L.sunDir,
      sunColor: lerp3(L.sunColor || [0, 0, 0], [0, 0, 0]),
      moonDir: L.moonDir,
      moonColor: lerp3(L.moonColor || [0, 0, 0], [0, 0, 0]),
    };
  }

  // -------------------------------------------------------------------------

  /** keepCamera: leave the orbit untouched (gear swap on the same actor). */
  setModel(model, keepCamera = false) {
    const gl = this.gl;
    for (const b of this.batches) {
      gl.deleteBuffer(b.vbo);
      if (b.wireEbo) gl.deleteBuffer(b.wireEbo);
      if (b.vao) gl.deleteVertexArray(b.vao);
    }
    for (const b of this.zoneBatches) {
      gl.deleteBuffer(b.vbo);
      if (b.vao) gl.deleteVertexArray(b.vao);
    }
    this.particleDrawer?.disposeMeshes();
    this.particleSystem = null;
    this.particleEnvironment = null;
    for (const t of this.textures.values()) gl.deleteTexture(t);
    this.batches = [];
    this.zoneBatches = [];
    this.textures.clear();
    this._freeOverlay(this.collisionOverlay);
    this.collisionOverlay = null;
    // Navmesh is loaded async and keyed to the zone — clear on every model swap.
    this._freeOverlay(this.navmeshOverlay);
    this.navmeshOverlay = null;
    this.currentAnimation = null;
    this.animFrame = 0;
    this.model = model;
    this.pose = null;
    this.poseDirty = true;

    if (!model || !model.isRenderable) return;

    this.camera.setRangeFor(model.kind === 'zone' ? 'zone' : 'entity');

    if (model.skeleton.joints.length > MAX_JOINTS)
      console.warn(`skeleton has ${model.skeleton.joints.length} joints (max ${MAX_JOINTS})`);

    this.pose = new SkeletonPose(model.skeleton, model.jointOverrides ?? null);

    for (const tex of model.textures.values()) {
      const t = this.createTexture(tex);
      if (t) this.textures.set(tex.name, t);
    }

    // Zones: ordered per-submesh draws, no skinning (see zoneModel.js).
    if (model.kind === 'zone') {
      for (const draw of model.zoneDraws ?? []) {
        const batch = this.buildZoneBatch(draw);
        if (batch) this.zoneBatches.push(batch);
      }
    }

    // Equipment occlusion (xim): a piece is dropped when another equipped mesh
    // declares an occludeType that hides this piece's display type — a helmet
    // hides hair, a sleeve hides the wrist, etc. Prevents the base skin/hair
    // clipping through worn gear.
    const occl = new Set(model.meshGroups.map((g) => g.occludeType ?? 0));
    for (const group of model.meshGroups) {
      for (const piece of group.pieces) {
        if (occludesDisplayType(piece.props?.displayType ?? 0, occl)) continue;
        const batch = this.buildBatch(group, piece);
        if (batch) this.batches.push(batch);
      }
    }
    // FFXI layers garment/skin geometry coincident and relies on authored draw
    // order (inner skin first, outer gear later) — the fixed-function pipeline
    // resolved ties deterministically. Under float depth the tie is per-pixel
    // luck, so skin patches win through the garment (belly/knee/wrist jaggies).
    // A tiny growing polygon offset makes each later batch win near-ties;
    // ~1 depth-ulp per batch, far below visible parallax.
    if (model.kind !== 'zone') {
      this.batches.forEach((b, i) => { b.depthNudge = -i; });
    }

    // Zone collision overlay (terrain-coloured); visibility via showCollision.
    if (model.kind === 'zone' && model.collision?.positions?.length) {
      this.collisionOverlay = this._buildOverlay(
        model.collision.positions,
        model.collision.colors,
      );
    }

    if (keepCamera) this.snapFloorToFeet();
    else this.fitCamera();
  }

  /** Load/replace navmesh overlay (display-space positions). Pass null to clear. */
  setNavmesh(nav) {
    this._freeOverlay(this.navmeshOverlay);
    this.navmeshOverlay = null;
    if (!nav?.positions?.length) return;
    // Solid Unreal-style green if no per-vert colours supplied.
    const n = nav.positions.length / 3;
    const colors = nav.colors || (() => {
      const c = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        c[i * 3] = 0.05; c[i * 3 + 1] = 0.85; c[i * 3 + 2] = 0.25;
      }
      return c;
    })();
    this.navmeshOverlay = this._buildOverlay(nav.positions, colors);
  }

  /**
   * Build the procedural sky dome (xim SkyBoxMesh) from a skyDomeFromEnv config:
   * { radius, spokes, slices:[{elevation, color:[r,g,b]}], horizon:[r,g,b] }.
   * Upper hemisphere in display space (+Y up); horizon ring at elevation 0.
   * Pass null to clear.
   */
  setSkyDome(config) {
    const gl = this.gl;
    if (this.skyDome) {
      gl.deleteVertexArray(this.skyDome.vao);
      gl.deleteBuffer(this.skyDome.vbo);
      this.skyDome = null;
    }
    if (!config || !(config.radius > 0) || !config.spokes || (config.slices?.length ?? 0) < 2) return;

    const { radius, spokes, slices } = config;
    const data = [];
    const vert = (theta, slice) => {
      const a = 0.5 * Math.PI * slice.elevation;   // 0 = horizon, π/2 = zenith
      const y = radius * Math.sin(a);
      const r = radius * Math.cos(a);
      data.push(r * Math.cos(theta), y, r * Math.sin(theta), slice.color[0], slice.color[1], slice.color[2], 1);
    };
    for (let i = 0; i < slices.length - 1; i++) {
      const lo = slices[i], hi = slices[i + 1];
      for (let j = 0; j < spokes; j++) {
        const t0 = (2 * Math.PI * j) / spokes;
        const t1 = (2 * Math.PI * (j + 1)) / spokes;
        vert(t0, lo); vert(t1, lo); vert(t1, hi);
        vert(t0, lo); vert(t1, hi); vert(t0, hi);
      }
    }
    const arr = new Float32Array(data);
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12);
    gl.bindVertexArray(null);
    this.skyDome = { vao, vbo, count: arr.length / 7, horizon: config.horizon || null };
  }

  _freeOverlay(o) {
    if (!o) return;
    const gl = this.gl;
    if (o.vbo) gl.deleteBuffer(o.vbo);
    if (o.vao) gl.deleteVertexArray(o.vao);
  }

  /** Interleaved pos(3)+color(3) overlay mesh. */
  _buildOverlay(positions, colors) {
    const gl = this.gl;
    const n = positions.length / 3;
    if (n < 3) return null;
    const data = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) {
      const o = i * 6, p = i * 3;
      data[o] = positions[p]; data[o + 1] = positions[p + 1]; data[o + 2] = positions[p + 2];
      data[o + 3] = colors[p]; data[o + 4] = colors[p + 1]; data[o + 5] = colors[p + 2];
    }
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);
    return { vao, vbo, count: n };
  }

  /** opts.frame — resume at this frame (gear swap); otherwise start at 0. */
  setAnimation(clip, opts = {}) {
    this.currentAnimation = clip;
    const len = clip?.lengthInFrames ?? 0;
    const frame = (opts.frame != null && len > 0) ? opts.frame % len : 0;
    this.animFrame = frame;
    if (this.pose) this.pose.evaluate(clip, frame);
    this.poseDirty = true;
  }

  fitCamera() {
    if (!this.pose || !this.model) return;
    const bounds = this.computeBounds();
    if (!bounds) return;
    this.camera.fit(bounds.min, bounds.max);
    this.snapFloorToFeet(bounds);
  }

  /**
   * Axis-aligned bounds of the skinned mesh in the current pose, plus a ground
   * ("feet") Y. FFXI is Y-down: larger Y = lower. Floor snaps to the lowest
   * mesh contact, not bone0 (root is often at the pelvis/origin and would bury
   * the legs — and a center-XZ heuristic missed wide stances / only-shoes bugs).
   *
   * Dangling weapon tips can sit slightly below the soles; we clamp how far
   * past the near-foot cluster the plane may drop so bosses don't hover.
   */
  computeBounds() {
    if (!this.pose || !this.model) return null;
    // Zones precompute bounds from sane placements — scanning millions of
    // baked verts is slow and a single wild coord used to blast the camera
    // to Z ≈ −1e7 (Ceizak Battlegrounds / ROM9/0/8.DAT).
    if (this.model.kind === 'zone' && this.model.zoneBounds) {
      const b = this.model.zoneBounds;
      return { min: b.min.slice(), max: b.max.slice(), footY: b.footY ?? b.min[1] };
    }
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    const ys = [];
    for (const group of this.model.meshGroups) {
      const pools = [group.vertices];
      if (group.flippedVertices) pools.push(group.flippedVertices);
      for (const pool of pools) {
        for (const v of pool) {
          const p = this.pose.skinPosition(v);
          ys.push(p[1]);
          for (let i = 0; i < 3; i++) {
            if (p[i] < min[i]) min[i] = p[i];
            if (p[i] > max[i]) max[i] = p[i];
          }
        }
      }
    }
    if (!isFinite(min[0]) || ys.length === 0) return null;

    ys.sort((a, b) => a - b);
    const yMin = ys[0];
    const yMax = ys[ys.length - 1];
    const height = Math.max(yMax - yMin, 1e-4);
    // Near-sole cluster (top 5% of Y). Median of that cluster ≈ real foot contact.
    const soleStart = Math.floor(ys.length * 0.95);
    const soles = ys.slice(soleStart);
    const soleMid = soles[Math.floor(soles.length * 0.5)];
    // Allow the plane a little below the sole mid for heel/toe, but not more than
    // ~3% of body height (stops a long sword tip from dragging the floor down).
    const maxDrop = height * 0.03;
    const footY = Math.min(yMax, soleMid + maxDrop);

    return { min, max, footY };
  }

  /** Place the ground plane under the actor's feet (Y-down floor line). */
  snapFloorToFeet(bounds) {
    const b = bounds ?? this.computeBounds();
    if (!b) return;
    this.modelMaxY = b.footY;
    this.modelMin = b.min;
    this.modelMax = b.max;
    if (this.floor) this.floorY = b.footY;
  }

  // -------------------------------------------------------------------------

  /**
   * One zone draw → one VAO. Interleaved p0(3f) p1(3f) n(3f) uv(2f) color(4u8),
   * stride 12 floats + 4 bytes = 52 B. Draw state (blend/cull/zBias/discard) is
   * carried on the batch and applied per draw, in list order.
   */
  buildZoneBatch(draw) {
    const gl = this.gl;
    const n = draw.count;
    if (!n || n < 3) return null;

    const stride = 13;                 // floats (last slot holds the packed color)
    const data = new Float32Array(n * stride);
    const dataU8 = new Uint8Array(data.buffer);
    for (let i = 0; i < n; i++) {
      const o = i * stride, i3 = i * 3, i2 = i * 2, i4 = i * 4;
      data[o] = draw.positions[i3]; data[o + 1] = draw.positions[i3 + 1]; data[o + 2] = draw.positions[i3 + 2];
      data[o + 3] = draw.blendOffsets[i3]; data[o + 4] = draw.blendOffsets[i3 + 1]; data[o + 5] = draw.blendOffsets[i3 + 2];
      data[o + 6] = draw.normals[i3]; data[o + 7] = draw.normals[i3 + 1]; data[o + 8] = draw.normals[i3 + 2];
      data[o + 9] = draw.uvs[i2]; data[o + 10] = draw.uvs[i2 + 1];
      const b = o * 4 + 12 * 4;
      dataU8[b] = draw.colors[i4];
      dataU8[b + 1] = draw.colors[i4 + 1];
      dataU8[b + 2] = draw.colors[i4 + 2];
      dataU8[b + 3] = draw.colors[i4 + 3];
    }

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    const bytes = stride * 4;
    const attr = (loc, size, offsetFloats) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, bytes, offsetFloats * 4);
    };
    attr(0, 3, 0); attr(1, 3, 3); attr(2, 3, 6); attr(3, 2, 9);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 4, gl.UNSIGNED_BYTE, true, bytes, 12 * 4);
    gl.bindVertexArray(null);

    return {
      vao,
      vbo,
      count: n,
      texture: draw.textureName ? this.textures.get(draw.textureName) ?? null : null,
      layer: draw.layer || 'world',
      blend: !!draw.blend,
      noCull: !!draw.noCull,
      discard: draw.discard || 0,
      wind: !!draw.wind,
      zBias: draw.zBias || 0,
      weather: draw.weather ?? null,     // sky cloud layer this belongs to (or null)
      celestial: !!draw.celestial,       // sun/moon/star — always shown
      positioned: !!draw.positioned,     // sun/moon disc — needs sky placement (skipped for now)
      uvScroll: draw.uvScroll || null,   // cloud UV drift from 0x05 generators
    };
  }

  buildBatch(group, piece) {
    const gl = this.gl;
    const pool = piece.mirrored ? group.flippedVertices : group.vertices;
    if (!pool || piece.corners.length < 3) return null;

    const stride = 19;   // floats per vertex (color packed as 4 u8 in the last slot)
    const data = new Float32Array(piece.corners.length * stride);
    const dataU8 = new Uint8Array(data.buffer);

    for (let i = 0; i < piece.corners.length; i++) {
      const c = piece.corners[i];
      const v = pool[Math.min(c.vi, pool.length - 1)];
      const o = i * stride;
      data[o] = v.p0[0]; data[o + 1] = v.p0[1]; data[o + 2] = v.p0[2];
      data[o + 3] = v.p1[0]; data[o + 4] = v.p1[1]; data[o + 5] = v.p1[2];
      data[o + 6] = v.n0[0]; data[o + 7] = v.n0[1]; data[o + 8] = v.n0[2];
      data[o + 9] = v.n1[0]; data[o + 10] = v.n1[1]; data[o + 11] = v.n1[2];
      const single = v.joint1 < 0;
      data[o + 12] = single ? 1 : v.w0;
      data[o + 13] = single ? 0 : v.w1;
      data[o + 14] = Math.min(v.joint0, MAX_JOINTS - 1);
      data[o + 15] = single ? 0 : Math.min(v.joint1, MAX_JOINTS - 1);
      data[o + 16] = c.u;
      data[o + 17] = c.v;
      // color: BGRA u32 -> RGBA bytes (normalized in shader)
      const b = i * stride * 4 + 18 * 4;
      dataU8[b] = (c.color >>> 16) & 0xff;
      dataU8[b + 1] = (c.color >>> 8) & 0xff;
      dataU8[b + 2] = c.color & 0xff;
      dataU8[b + 3] = (c.color >>> 24) & 0xff;
    }

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    const bytes = stride * 4;
    const attr = (loc, size, offsetFloats) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, bytes, offsetFloats * 4);
    };
    attr(0, 3, 0); attr(1, 3, 3); attr(2, 3, 6); attr(3, 3, 9);
    attr(4, 2, 12); attr(5, 2, 14); attr(6, 2, 16);
    gl.enableVertexAttribArray(7);
    gl.vertexAttribPointer(7, 4, gl.UNSIGNED_BYTE, true, bytes, 18 * 4);

    // Wireframe edge list (fallback when WEBGL_polygon_mode is missing).
    const isStrip = piece.topology === 'strip';
    const wireIdx = buildWireIndices(piece.corners.length, isStrip);
    let wireEbo = null;
    if (wireIdx) {
      wireEbo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, wireEbo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, wireIdx, gl.STATIC_DRAW);
    }
    gl.bindVertexArray(null);

    // Entity pieces have no alphaMode → 0 (two-pass). Zone pieces set opaque/cutout/blend.
    const alphaMode = piece.alphaMode === 'opaque' ? 1
      : piece.alphaMode === 'cutout' ? 2
        : piece.alphaMode === 'blend' ? 3
          : 0;

    return {
      vao,
      vbo,
      wireEbo,
      wireCount: wireIdx ? wireIdx.length : 0,
      mode: isStrip ? gl.TRIANGLE_STRIP : gl.TRIANGLES,
      count: piece.corners.length,
      texture: piece.textureName ? this.textures.get(piece.textureName) ?? null : null,
      alphaMode,
      layer: piece.layer || 'world', // 'world' | 'env' (sky/water)
    };
  }

  createTexture(image, opts = {}) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

    // Undither path needs RGBA so we can average the stipple into smooth alpha.
    // Compressed GPU upload keeps 1-bit DXT1 alpha and would still checkerboard.
    if (opts.unditherAlpha) {
      let rgba = image.format === 'rgba32'
        ? image.data
        : decodeDxt(image.data, image.width, image.height, image.format === 'dxt1' ? 1 : 3);
      rgba = unditherAlphaRGBA(rgba, image.width, image.height);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, image.width, image.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return tex;
    }

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    if (image.format === 'rgba32') {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, image.width, image.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, image.data);
    } else if (this.s3tc) {
      const fmt = image.format === 'dxt1'
        ? this.s3tc.COMPRESSED_RGBA_S3TC_DXT1_EXT
        : this.s3tc.COMPRESSED_RGBA_S3TC_DXT3_EXT;
      gl.compressedTexImage2D(gl.TEXTURE_2D, 0, fmt, image.width, image.height, 0, image.data);
    } else {
      const rgba = image.format === 'dxt1'
        ? decodeDxt(image.data, image.width, image.height, 1)
        : decodeDxt(image.data, image.width, image.height, 3);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, image.width, image.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    }
    return tex;
  }

  // -------------------------------------------------------------------------

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(Math.round(this.canvas.clientWidth * dpr), 1);
    const h = Math.max(Math.round(this.canvas.clientHeight * dpr), 1);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  render(dtSeconds) {
    const gl = this.gl;
    this.resize();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    // When the sky dome is shown, clear to its horizon colour so the background
    // below the horizon ring (and beyond the dome radius) matches seamlessly.
    const skyOn = this.model?.kind === 'zone' && this.showSkybox && this.skyDome;
    const cc = skyOn && this.skyDome.horizon ? this.skyDome.horizon : this.clearColor;
    gl.clearColor(cc[0], cc[1], cc[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    if (this.playing && this.currentAnimation && this.pose) {
      this.animFrame += dtSeconds * 30;   // FFXI runs at 30 game-frames/sec
      const len = this.currentAnimation.lengthInFrames;
      if (this.animFrame > len) this.animFrame %= len;
      this.pose.evaluate(this.currentAnimation, this.animFrame);
      this.poseDirty = true;
    }

    // xim WindFactor.update: step 1/60 per game frame (30fps) → 2s per leg.
    this.windFactor += dtSeconds * 0.5 * this.windDir;
    if (this.windFactor >= 1) { this.windFactor = 1; this.windDir = -1; }
    else if (this.windFactor <= 0) { this.windFactor = 0; this.windDir = 1; }

    this._updateEnvironment(dtSeconds);

    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);

    const aspect = this.canvas.width / this.canvas.height;
    // The Explorer panel overlays the left of the canvas, so the scene is nudged
    // right in NDC to stay centred in the visible area. The shift is folded into
    // the projection rather than the combined view-projection so that *every*
    // pass shares it — a pass that rebuilds its own projection (the particle
    // drawer needs proj and view separately) would otherwise draw its geometry
    // offset from the world. Because the offset is in NDC, the resulting
    // mismatch grows with depth, which reads on screen as parallax.
    let proj = this.camera.projectionMatrix(aspect);
    if (this.screenOffsetX) {
      const dpr = window.devicePixelRatio || 1;
      const dx = (2 * this.screenOffsetX * dpr) / this.canvas.width;
      const shift = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, dx, 0, 0, 1]);
      proj = mat4Multiply(shift, proj);
    }
    this.projMatrix = proj;
    const viewProj = mat4Multiply(proj, this.camera.viewMatrix());
    const eye = this.camera.eye;
    const fogFar = this.fog.enabled ? this.fog.far : -1;

    // Floor first (writes depth so the model occludes correctly).
    if (this.floor) {
      gl.useProgram(this.floorProgram);
      gl.uniformMatrix4fv(this.floorUniforms.viewProj, false, viewProj);
      gl.uniform1f(this.floorUniforms.tile, this.floorTile);
      gl.uniform1f(this.floorUniforms.y, this.floorY);
      gl.uniform1i(this.floorUniforms.texture, 0);
      gl.uniform3fv(this.floorUniforms.cameraPos, eye);
      gl.uniform3fv(this.floorUniforms.fogColor, this.fog.color);
      gl.uniform2f(this.floorUniforms.fogRange, this.fog.near, fogFar);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.floor.texture);
      gl.bindVertexArray(this.floorVao);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindVertexArray(null);
    }

    // Zones take the dedicated ordered path (xim ZoneDrawer.drawZoneObjects).
    if (this.model?.kind === 'zone') {
      // Sky is the 0x2F gradient dome plus particles (clouds, sun, moon, stars),
      // exactly as xim does it — there is no separate textured sky-shell pass.
      if (this.showSkybox) this._drawSky(viewProj, eye);
      this._drawZone(viewProj, eye, fogFar);
      this._drawParticles();
      this._drawOverlay(viewProj, this.showCollision ? this.collisionOverlay : null, this.collisionOpacity);
      this._drawOverlay(viewProj, this.showNavmesh ? this.navmeshOverlay : null, this.navmeshOpacity);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);   // surfaces may leave REVERSE_SUBTRACT set
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(0, 0);
      gl.bindVertexArray(null);
      return;
    }

    if (!this.pose || this.batches.length === 0) return;

    gl.useProgram(this.program);
    if (this.poseDirty) {
      this.pose.pack(this.rotArray, this.transArray, this.scaleArray);
      this.poseDirty = false;
    }
    gl.uniform4fv(this.uniforms.rot, this.rotArray);
    gl.uniform4fv(this.uniforms.trans, this.transArray);
    gl.uniform4fv(this.uniforms.scale, this.scaleArray);
    gl.uniformMatrix4fv(this.uniforms.viewProj, false, viewProj);
    gl.uniform3fv(this.uniforms.lightDir, this.camera.forward);
    gl.uniform1i(this.uniforms.texture, 0);
    gl.uniform3fv(this.uniforms.cameraPos, eye);
    gl.uniform3fv(this.uniforms.fogColor, this.fog.color);
    gl.uniform2f(this.uniforms.fogRange, this.fog.near, fogFar);

    gl.activeTexture(gl.TEXTURE0);
    const alphaOn = !!this.showAlpha;
    gl.uniform1f(this.uniforms.showAlpha, alphaOn ? 1 : 0);
    // Zones use xim terrain lighting (ambient + sun + moon from 0x2F env).
    const isZone = this.model?.kind === 'zone';
    gl.uniform1f(this.uniforms.terrainLit, isZone ? 1 : 0);
    if (isZone) {
      const L = this._zoneLightUniforms();
      gl.uniform3fv(this.uniforms.ambient, L.ambient);
      gl.uniform3fv(this.uniforms.sunDir, L.sunDir);
      gl.uniform3fv(this.uniforms.sunColor, L.sunColor);
      gl.uniform3fv(this.uniforms.moonDir, L.moonDir);
      gl.uniform3fv(this.uniforms.moonColor, L.moonColor);
    } else {
      gl.uniform3fv(this.uniforms.ambient, [1, 1, 1]);
      gl.uniform3fv(this.uniforms.sunDir, [0, 1, 0]);
      gl.uniform3fv(this.uniforms.sunColor, [0, 0, 0]);
      gl.uniform3fv(this.uniforms.moonDir, [0, -1, 0]);
      gl.uniform3fv(this.uniforms.moonColor, [0, 0, 0]);
    }

    const usePolyMode = this.showWireframe && this.polygonMode;
    if (usePolyMode) {
      this.polygonMode.polygonModeWEBGL(gl.FRONT_AND_BACK, this.polygonMode.LINE_WEBGL);
    }

    // pred filters batches; alphaMode is set per draw (zone opaque/cutout/blend).
    // depthNudge: later batches pull ~1 depth-ulp/batch toward the viewer so
    // outer garment layers deterministically win ties against the skin under
    // them (see setModel).
    const showEnv = !!this.showSkybox;
    gl.enable(gl.POLYGON_OFFSET_FILL);
    const drawBatches = (asWire, pred) => {
      for (const batch of this.batches) {
        if ((batch.layer === 'sky' || batch.layer === 'water') && !showEnv) continue;
        if (pred && !pred(batch)) continue;
        gl.uniform1i(this.uniforms.alphaMode, batch.alphaMode ?? 0);
        gl.polygonOffset(0, batch.depthNudge ?? 0);
        gl.bindTexture(gl.TEXTURE_2D, this.showTextures && batch.texture ? batch.texture : this.whiteTexture);
        gl.bindVertexArray(batch.vao);
        if (asWire && batch.wireEbo) {
          gl.drawElements(gl.LINES, batch.wireCount, gl.UNSIGNED_INT, 0);
        } else {
          gl.drawArrays(batch.mode, 0, batch.count);
        }
      }
    };

    const wireFallback = this.showWireframe && !usePolyMode;
    const modeOf = (b) => b.alphaMode ?? 0;

    // Solid depth-write pass: entity batches + zone opaque/cutout (not blend).
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.uniform1i(this.uniforms.alphaPass, 0);
    drawBatches(wireFallback, (b) => modeOf(b) !== 3);

    // Translucent pass: entity membrane/glass (mode 0) + zone soft-edge/water
    // blend (mode 3). Depth-test ON, depth-write OFF so soft terrain edges
    // composite over the opaque base instead of z-fighting into hard rectangles.
    if (alphaOn && !wireFallback) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.uniform1i(this.uniforms.alphaPass, 1);
      drawBatches(false, (b) => {
        const m = modeOf(b);
        return m === 0 || m === 3;
      });
    }

    if (usePolyMode) {
      this.polygonMode.polygonModeWEBGL(gl.FRONT_AND_BACK, this.polygonMode.FILL_WEBGL);
    }

    // Debug overlays on top (collision terrain colours, UE-green navmesh).
    this._drawOverlay(viewProj, this.showCollision ? this.collisionOverlay : null, this.collisionOpacity);
    this._drawOverlay(viewProj, this.showNavmesh ? this.navmeshOverlay : null, this.navmeshOpacity);

    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(0, 0);
    gl.bindVertexArray(null);
  }

  /**
   * Zone terrain, drawn in authored DAT order with per-submesh state — the
   * faithful shape of xim's GLDrawer.drawXim loop:
   *
   *   blend submesh : BLEND(SRC_ALPHA, ONE_MINUS_SRC_ALPHA, FUNC_ADD), depthMask off,
   *                   POLYGON_OFFSET_FILL polygonOffset(-zBias, 1)   [zBias = 5]
   *   opaque submesh: BLEND off, depthMask on, no polygon offset
   *   culling       : on (frontFace CW, cull BACK) unless the 0x2000 flag is set
   *   discard       : 0.375 for '_' meshes, else none
   *
   * No global opaque/translucent split and no reordering: FFXI authored the DAT
   * order so overlay/decal submeshes composite over the surfaces drawn before
   * them. Sorting or bucketing here is exactly what breaks that layering.
   */
  _drawZone(viewProj, eye, fogFar) {
    const gl = this.gl;
    if (this.zoneBatches.length === 0) return;

    const usePolyMode = this.showWireframe && this.polygonMode;
    if (usePolyMode) {
      this.polygonMode.polygonModeWEBGL(gl.FRONT_AND_BACK, this.polygonMode.LINE_WEBGL);
    }

    gl.useProgram(this.zoneProgram);
    gl.uniformMatrix4fv(this.zoneUniforms.viewProj, false, viewProj);
    gl.uniform1i(this.zoneUniforms.texture, 0);
    gl.uniform3fv(this.zoneUniforms.cameraPos, eye);
    gl.uniform3fv(this.zoneUniforms.fogColor, this.fog.color);
    gl.uniform2f(this.zoneUniforms.fogRange, this.fog.near, fogFar);

    const L = this._zoneLightUniforms();
    gl.uniform3fv(this.zoneUniforms.ambient, L.ambient);
    gl.uniform3fv(this.zoneUniforms.sunDir, L.sunDir);
    gl.uniform3fv(this.zoneUniforms.sunColor, L.sunColor);
    gl.uniform3fv(this.zoneUniforms.moonDir, L.moonDir);
    gl.uniform3fv(this.zoneUniforms.moonColor, L.moonColor);

    const alphaOn = !!this.showAlpha;
    gl.uniform1f(this.zoneUniforms.showAlpha, alphaOn ? 1 : 0);
    gl.uniform3f(this.zoneUniforms.center, 0, 0, 0);   // world geometry is not camera-centred
    gl.uniform2f(this.zoneUniforms.uvOffset, 0, 0);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.frontFace(gl.CW);
    gl.cullFace(gl.BACK);
    gl.activeTexture(gl.TEXTURE0);

    // Track state so identical consecutive draws don't re-issue GL calls.
    let curBlend = null, curCull = null, curBias = null, curDiscard = null, curWind = null, curTex = null;

    for (const batch of this.zoneBatches) {
      // Everything here is placed world geometry; sky shells and 0x05 effect
      // meshes are drawn by the particle system, not from this list.

      // Alpha toggled off in the viewer: draw blend submeshes as solids.
      const blend = alphaOn && batch.blend;
      if (blend !== curBlend) {
        if (blend) {
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          gl.blendEquation(gl.FUNC_ADD);
          gl.depthMask(false);
        } else {
          gl.disable(gl.BLEND);
          gl.depthMask(true);
        }
        curBlend = blend;
      }

      const cull = !batch.noCull && !this.zoneDisableCull;
      if (cull !== curCull) {
        if (cull) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);
        curCull = cull;
      }

      const bias = batch.zBias;
      if (bias !== curBias) {
        if (bias) {
          gl.enable(gl.POLYGON_OFFSET_FILL);
          gl.polygonOffset(-bias, 1);
        } else {
          gl.disable(gl.POLYGON_OFFSET_FILL);
        }
        curBias = bias;
      }

      const discard = alphaOn ? batch.discard : 0;
      if (discard !== curDiscard) {
        gl.uniform1f(this.zoneUniforms.discard, discard);
        curDiscard = discard;
      }

      const wind = batch.wind ? this.windFactor : 0;
      if (wind !== curWind) {
        gl.uniform1f(this.zoneUniforms.wind, wind);
        curWind = wind;
      }

      const tex = (this.showTextures && batch.texture) ? batch.texture : this.whiteTexture;
      if (tex !== curTex) {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        curTex = tex;
      }

      gl.bindVertexArray(batch.vao);
      gl.drawArrays(gl.TRIANGLES, 0, batch.count);
    }

    if (usePolyMode) {
      this.polygonMode.polygonModeWEBGL(gl.FRONT_AND_BACK, this.polygonMode.FILL_WEBGL);
    }
  }

  // --- Live particle system (xim ParticleDrawer) ---------------------------

  /**
   * Attach the zone's particle system. The renderer owns the per-frame step so
   * the simulation advances on the same clock as the rest of the scene, and the
   * camera adapter lives here because only the renderer knows the view matrix.
   *
   * Particle maths runs in raw DAT space while the scene is drawn in display
   * space (−x, −y, z); that mapping is a 180° rotation about Z and is its own
   * inverse, so the adapter uses it in both directions.
   */
  setParticleSystem(system, environment = null) {
    this.particleSystem = system;
    this.particleEnvironment = environment;
    if (!system) return;

    const toDat = (v) => new Vec3(-v.x, -v.y, v.z);
    const self = this;
    system.camera = {
      getPosition() {
        const e = self.camera.eye;
        return toDat(new Vec3(e[0], e[1], e[2]));
      },
      getViewVector() {
        const f = self.camera.forward;
        return toDat(new Vec3(f[0], f[1], f[2])).normalizeInPlace();
      },
      /**
       * xim reads the camera basis straight off the view matrix rows
       * (lookAtLeft / lookAtUp / lookAtForward). Note "forward" there is the
       * look-at *direction* vector, which points from the target back toward the
       * eye — deriving these from the true forward vector instead flips X and Z
       * and throws camera-attached effects to the wrong side of the viewer.
       */
      getBasis() {
        const m = self.camera.viewMatrix();
        return {
          left: toDat(new Vec3(m[0], m[4], m[8])),
          up: toDat(new Vec3(m[1], m[5], m[9])),
          forward: toDat(new Vec3(m[2], m[6], m[10])),
        };
      },
      getFoV: () => self.camera.fov ?? (Math.PI / 4),
      toCameraSpace(v) {
        const e = self.camera.eye;
        return toDat(new Vec3(e[0], e[1], e[2])).sub(v).scaleInPlace(-1);
      },
    };
  }

  /**
   * Advance the game clock, the weather cross-fade and the particle simulation.
   * Runs before any drawing so terrain, sky and particles all read the same
   * environment for this frame — otherwise fog lags the sky by one frame during
   * a weather change and the transition visibly tears.
   */
  _updateEnvironment(dtSeconds) {
    const system = this.particleSystem;
    if (!system) return;

    // FFXI's simulation is fixed at 30 frames per second; clamp so a stalled tab
    // doesn't fast-forward every effect on the next frame.
    const elapsedFrames = Math.min(4, Math.max(0, (dtSeconds || 1 / 60) * 30));

    const env = this.particleEnvironment;
    if (env) {
      env.update(elapsedFrames, { advanceClock: this.advanceGameClock === true });

      // xim SkyBoxMesh.isExpired: the dome is rebuilt when the clock has moved
      // more than a game-minute, and continuously while weather cross-fades.
      // Without the time check the sky and its lighting stay frozen at whatever
      // hour the zone loaded at.
      const tod = env.clock.currentTimeOfDayInSeconds();
      const stale = this._skyBuiltAt == null || tod < this._skyBuiltAt || tod > this._skyBuiltAt + 60;
      if (env.weatherTransition || stale) {
        this.setTerrainLighting(env.getTerrainLighting());
        this.setSkyDome(env.getSkyDome());
        this._skyBuiltAt = tod;
      }
    }

    system.update(elapsedFrames);
    this.weatherAudio?.update();
  }

  _drawParticles() {
    // Not gated on showSkybox: water, spray and fountains are world effects, and
    // hiding the sky shouldn't drain the sea. View > Toggle Effects hides them.
    const system = this.particleSystem;
    if (!system || this.showEffects === false) return;
    if (!this.particleDrawer) this.particleDrawer = new ParticleDrawer(this.gl);
    this.particleDrawer.setTextures(this.textures);

    this.particleDrawer.draw({
      system,
      view: this.camera.viewMatrix(),
      // Must be the same projection the zone pass used, Explorer offset and all.
      proj: this.projMatrix,
      lighting: this._zoneLightUniforms(),
      fog: this.fog,
      showTextures: this.showTextures,
    });
    this.particleDrawer.drawScreenFlashes(system.getScreenFlashes());
  }

  getParticleStats() {
    return {
      ...(this.particleDrawer?.lastStats ?? { drawn: 0, particles: 0 }),
      live: this.particleSystem?.effectManager.countParticles() ?? 0,
    };
  }

  /**
   * Sky dome (xim: drawn first, depth-write off). We also disable the depth
   * test and centre the dome on the camera, so it always fills the background
   * and wraps the free-fly camera regardless of zone extent. Everything drawn
   * after paints over it.
   */
  _drawSky(viewProj, eye) {
    if (!this.skyDome) return;
    const gl = this.gl;
    gl.useProgram(this.skyProgram);
    gl.uniformMatrix4fv(this.skyUniforms.viewProj, false, viewProj);
    gl.uniform3fv(this.skyUniforms.center, eye);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.skyDome.vao);
    gl.drawArrays(gl.TRIANGLES, 0, this.skyDome.count);
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
  }

  _drawOverlay(viewProj, overlay, opacity) {
    if (!overlay) return;
    const gl = this.gl;
    gl.useProgram(this.overlayProgram);
    gl.uniformMatrix4fv(this.overlayUniforms.viewProj, false, viewProj);
    gl.uniform1f(this.overlayUniforms.opacity, opacity);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -1); // sit just above the terrain
    gl.bindVertexArray(overlay.vao);
    gl.drawArrays(gl.TRIANGLES, 0, overlay.count);
    gl.bindVertexArray(null);
  }
}

/**
 * Whether a piece with this render displayType is hidden by the set of
 * occludeTypes declared across all equipped meshes (xim ActorModel.isOccluded).
 * displayType: 1/2/3 = hair, 4 = face, 5 = wrist, 6 = pants, 7 = shins.
 * (0x11/0x21/0x31 are body/legs/feet self-markers and hide nothing.)
 */
function occludesDisplayType(displayType, occl) {
  switch (displayType) {
    case 1: return occl.has(0x02) || occl.has(0x03) || occl.has(0x04) || occl.has(0x05) || occl.has(0x06);
    case 2:
    case 3: return occl.has(0x04) || occl.has(0x05) || occl.has(0x06);
    case 4: return occl.has(0x05);
    case 5: return occl.has(0x12);
    case 6: return occl.has(0x32);
    case 7: return occl.has(0x22);
    default: return false;
  }
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16 & 0xff) / 255, (v >> 8 & 0xff) / 255, (v & 0xff) / 255];
}

// ---------------------------------------------------------------------------

function buildProgram(gl, vsSource, fsSource) {
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vsSource));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fsSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(program));
  return program;
}

function makeWhiteTexture(gl) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  return tex;
}

/** CPU fallback DXT1/DXT3 decode (standard block layout). */
function decodeDxt(data, width, height, variant) {
  const out = new Uint8Array(width * height * 4);
  const blocksX = Math.max(width >> 2, 1);
  const blocksY = Math.max(height >> 2, 1);
  const blockBytes = variant === 1 ? 8 : 16;

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const off = (by * blocksX + bx) * blockBytes;
      const colorOff = variant === 1 ? off : off + 8;

      const c0 = data[colorOff] | (data[colorOff + 1] << 8);
      const c1 = data[colorOff + 2] | (data[colorOff + 3] << 8);
      const indices = data[colorOff + 4] | (data[colorOff + 5] << 8) | (data[colorOff + 6] << 16) | (data[colorOff + 7] << 24);

      const r0 = ((c0 >> 11) & 31) * 255 / 31, g0 = ((c0 >> 5) & 63) * 255 / 63, b0 = (c0 & 31) * 255 / 31;
      const r1 = ((c1 >> 11) & 31) * 255 / 31, g1 = ((c1 >> 5) & 63) * 255 / 63, b1 = (c1 & 31) * 255 / 31;

      const palette = [[r0, g0, b0, 255], [r1, g1, b1, 255]];
      if (variant === 1 && c0 <= c1) {
        palette.push([(r0 + r1) / 2, (g0 + g1) / 2, (b0 + b1) / 2, 255], [0, 0, 0, 0]);
      } else {
        palette.push(
          [(2 * r0 + r1) / 3, (2 * g0 + g1) / 3, (2 * b0 + b1) / 3, 255],
          [(r0 + 2 * r1) / 3, (g0 + 2 * g1) / 3, (b0 + 2 * b1) / 3, 255],
        );
      }

      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px, y = by * 4 + py;
          if (x >= width || y >= height) continue;
          const pi = py * 4 + px;
          const c = palette[(indices >>> (pi * 2)) & 3];
          const o = (y * width + x) * 4;
          out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2];
          out[o + 3] = variant === 3
            ? (((readAlpha4(data, off, pi)) * 17))
            : c[3];
        }
      }
    }
  }
  return out;
}

function readAlpha4(data, blockOff, pixelIndex) {
  const byte = data[blockOff + (pixelIndex >> 1)];
  return pixelIndex & 1 ? (byte >> 4) & 0xf : byte & 0xf;
}

/**
 * Decodes a parsed texture ({ format, data, width, height }) to RGBA bytes for
 * 2D canvas display (texture viewer). FFXI stores opaque as 0x80, not 0xFF —
 * the GL shader doubles alpha at draw time; bake that same ×2 here so opaque
 * texels aren't ~50% see-through on the checkerboard (cexi DEFAULT_ALPHA_SCALE).
 */
export function decodeTextureRGBA(tex) {
  const raw = tex.format === 'rgba32'
    ? tex.data
    : decodeDxt(tex.data, tex.width, tex.height, tex.format === 'dxt1' ? 1 : 3);
  return scaleAlpha2x(raw);
}

/** Multiply every alpha byte by 2, clamped to 255 (FFXI half-scale → display). */
function scaleAlpha2x(rgba) {
  const out = rgba instanceof Uint8Array ? new Uint8Array(rgba) : new Uint8Array(rgba);
  for (let i = 3; i < out.length; i += 4) out[i] = Math.min(255, out[i] * 2);
  return out;
}

/**
 * Convert PS2/FFXI dithered (checkerboard) alpha into continuous alpha.
 * A 5×5 box filter turns 50% stipple into ~0.5 everywhere; transparent DXT1
 * holes borrow RGB from opaque neighbours so black texels don't speck the sky.
 */
function unditherAlphaRGBA(src, w, h) {
  const out = new Uint8Array(src.length);
  const R = 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let aSum = 0, n = 0, rSum = 0, gSum = 0, bSum = 0, wSum = 0;
      for (let dy = -R; dy <= R; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const i = (yy * w + xx) * 4;
          const a = src[i + 3];
          aSum += a;
          n++;
          if (a > 0) {
            rSum += src[i] * a;
            gSum += src[i + 1] * a;
            bSum += src[i + 2] * a;
            wSum += a;
          }
        }
      }
      const o = (y * w + x) * 4;
      const aSrc = src[o + 3];
      if (aSrc < 8 && wSum > 0) {
        out[o] = (rSum / wSum + 0.5) | 0;
        out[o + 1] = (gSum / wSum + 0.5) | 0;
        out[o + 2] = (bSum / wSum + 0.5) | 0;
      } else {
        out[o] = src[o];
        out[o + 1] = src[o + 1];
        out[o + 2] = src[o + 2];
      }
      out[o + 3] = n ? ((aSum / n) + 0.5) | 0 : aSrc;
    }
  }
  return out;
}
