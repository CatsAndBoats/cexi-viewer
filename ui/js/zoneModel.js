// Convert a parseZone() result into the ordered draw list the WebGL zone
// renderer consumes. Zones use the level-editor display frame (−x, −y, z) with
// a Y-up camera.
//
// Faithful to xim's ZoneDrawer/GLDrawer: geometry is emitted in DAT order
// (objectDrawOrder → per-object submesh order), opaque and blend interleaved,
// with each submesh's own render state (blend / cull / z-bias / discard). Only
// ADJACENT draws sharing identical state+texture are merged, so batching never
// reorders anything — FFXI relies on the authored order for overlay layering.

import { resolveMeshName, resolveTexture, isSkyName, isWaterName, isEnvName } from './zone.js';

/** Column-major TRS = T · Rz·Ry·Rx · S (xim / cexi rotateZYX). */
function trsMatrix(pos, rot, scale) {
  const [px, py, pz] = pos;
  const [rx, ry, rz] = rot;
  const [sx, sy, sz] = scale;
  const sinx = Math.sin(rx), siny = Math.sin(ry), sinz = Math.sin(rz);
  const cosx = Math.cos(rx), cosy = Math.cos(ry), cosz = Math.cos(rz);
  const c0 = [cosy * cosz, cosy * sinz, -siny];
  const c1 = [sinx * siny * cosz - cosx * sinz, sinx * siny * sinz + cosx * cosz, sinx * cosy];
  const c2 = [cosx * siny * cosz + sinx * sinz, cosx * siny * sinz - sinx * cosz, cosx * cosy];
  return [
    c0[0] * sx, c0[1] * sx, c0[2] * sx, 0,
    c1[0] * sy, c1[1] * sy, c1[2] * sy, 0,
    c2[0] * sz, c2[1] * sz, c2[2] * sz, 0,
    px, py, pz, 1,
  ];
}

const IDENTITY = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

function mulPoint(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

function mulDir(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z,
    m[1] * x + m[5] * y + m[9] * z,
    m[2] * x + m[6] * y + m[10] * z,
  ];
}

// Display space — same net transform as the level editor zoneRoot:
//   180° about X then scale(−1,1,−1) ⇒ (−x, −y, z). Y-up camera (see camera.js).
function toDisplay(x, y, z) {
  return [-x, -y, z];
}

// Classify a sky-shell mesh: weather from the DAT weat/<id>/ folder when known,
// else from the mesh name (clod_a01 / cld_fine_a01 / …). Celestials always on.
// Celestial checks run BEFORE weather substring match so "stardust" isn't "dust".
const SKY_WEATHER_IDS = ['fine', 'suny', 'clod', 'mist', 'dryw', 'heat', 'rain', 'squl',
  'dust', 'sand', 'wind', 'stom', 'snow', 'bliz', 'thdr', 'bolt', 'aura', 'ligt', 'fogd', 'dark'];
function isCelestialName(n) {
  // suny_* is sunshine-weather clouds, not the sun body (sun/sunsphere).
  if (n.startsWith('suny')) return false;
  if (n.includes('sphere')) return true;
  return n.startsWith('sun') || n.startsWith('moon') || n.startsWith('star');
}

function skyClassOf(name, dirWeather = null) {
  const n = (name || '').toLowerCase();
  // Sun/moon discs are small meshes meant to sit far away at the sun/moon
  // *direction* (a pole vertex at the local origin), not wrapped on the camera.
  // Flag them 'positioned' so the renderer can skip them until placed properly
  // — otherwise camera-centring drags that pole to the eye (screen-wide wedge).
  if (isCelestialName(n)) {
    return { weather: null, celestial: true, positioned: n.includes('sphere') };
  }
  if (dirWeather) return { weather: dirWeather, celestial: false, positioned: false };
  for (const w of SKY_WEATHER_IDS) if (n.includes(w)) return { weather: w, celestial: false, positioned: false };
  return { weather: null, celestial: false, positioned: false };   // unknown → always shown
}

const clamp255 = (v) => Math.max(0, Math.min(255, (v * 255 + 0.5) | 0));

/**
 * Alpha-discard threshold for a submesh (xim ZoneMeshSection:119). Keyed purely
 * on the MESH name: `_`-prefixed models (foliage, grates, overlay structs) are
 * alpha-tested at 0.375 against `4 * vertexAlpha * texAlpha`; everything else
 * uses 0 (no discard). Independent of the 0x8000 blend flag — a `_` mesh that is
 * also blend-enabled gets both.
 */
function discardThresholdFor(meshName) {
  return (meshName || '').startsWith('_') ? 0.375 : 0;
}

/** Determinant of a column-major TRS matrix's 3×3 part (mirrored when < 0). */
function det3(m) {
  return m[0] * (m[5] * m[10] - m[6] * m[9])
    - m[4] * (m[1] * m[10] - m[2] * m[9])
    + m[8] * (m[1] * m[6] - m[2] * m[5]);
}

// Hidden/deleted placements are shoved to y ≈ −100000 (cexi). Some DATs also
// carry garbage coords on one axis (e.g. Z ≈ −1e7) that blow out camera fit.
const COORD_LIMIT = 50000;
function isSanePlacement(p) {
  if (p.pos[1] <= -90000) return false;
  for (let i = 0; i < 3; i++) {
    const v = p.pos[i];
    if (!Number.isFinite(v) || Math.abs(v) > COORD_LIMIT) return false;
  }
  return true;
}

/** Local AABB of a mesh's prims (raw FFXI space). */
function meshLocalBounds(prims) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const prim of prims) {
    const n = prim.positions.length / 3;
    for (let i = 0; i < n; i++) {
      const x = prim.positions[i * 3], y = prim.positions[i * 3 + 1], z = prim.positions[i * 3 + 2];
      if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
    }
  }
  if (!isFinite(minX)) return null;
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/** Transform local AABB corners → display-space AABB. */
function transformBoundsDisplay(local, matrix) {
  const [xmin, ymin, zmin] = local.min;
  const [xmax, ymax, zmax] = local.max;
  const corners = [
    [xmin, ymin, zmin], [xmax, ymin, zmin], [xmin, ymax, zmin], [xmax, ymax, zmin],
    [xmin, ymin, zmax], [xmax, ymin, zmax], [xmin, ymax, zmax], [xmax, ymax, zmax],
  ];
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const [x, y, z] of corners) {
    const [wx, wy, wz] = mulPoint(matrix, x, y, z);
    const [dx, dy, dz] = toDisplay(wx, wy, wz);
    if (dx < minX) minX = dx; if (dy < minY) minY = dy; if (dz < minZ) minZ = dz;
    if (dx > maxX) maxX = dx; if (dy > maxY) maxY = dy; if (dz > maxZ) maxZ = dz;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/**
 * @param {{ meshes: Map, placements: any[], textures: Map, collision?: any }} parsed
 * @param {string} sourceName
 * @param {{ includeSky?: boolean }} [opts]  includeSky kept for compat; sky/water
 *   always baked into a separate `env` layer and toggled in the renderer.
 */
export function zoneToModel(parsed, sourceName = '', opts = {}) {
  const { meshes, placements, textures: texMap, collision: rawCollision } = parsed;

  // Precompute local bounds per mesh (for placement focus + zone camera fit).
  const localBounds = new Map();
  for (const [name, prims] of meshes) {
    const b = meshLocalBounds(prims);
    if (b) localBounds.set(name, b);
  }

  // Ordered draw list. One entry per (object, submesh) in DAT order; adjacent
  // entries with identical state+texture are appended into the previous entry so
  // the merge can never reorder a draw (xim relies on the authored order).
  const draws = [];
  let triCount = 0;

  const emitPrim = (meshName, prim, matrix, layer = 'world', dirWeather = null) => {
    const texKey = resolveTexture(prim.textureName, texMap) || prim.textureName || '';
    const discard = discardThresholdFor(meshName);
    const wind = !!prim.hasBlendPos;
    // Mirrored placements (negative-determinant TRS) flip triangle winding once
    // the transform is baked in; pre-swap so the renderer keeps one fixed
    // front-face convention (xim instead flips frontFace per draw).
    const mirrored = det3(matrix) < 0;

    // Sky shells: weather from weat/<id>/ directory when known, else mesh name.
    // Celestials always shown; cloud layers only when skyWeather matches.
    const sky = layer === 'sky' ? skyClassOf(meshName, dirWeather) : null;
    const blend = prim.blend;

    const last = draws[draws.length - 1];
    let d = last;
    if (!d || d.layer !== layer || d.texKey !== texKey || d.blend !== blend
      || d.noCull !== prim.noCull || d.discard !== discard || d.wind !== wind
      || d.weather !== (sky?.weather ?? null) || d.celestial !== !!sky?.celestial
      || d.positioned !== !!sky?.positioned) {
      d = {
        layer, texKey, blend, noCull: prim.noCull, discard, wind,
        weather: sky?.weather ?? null, celestial: !!sky?.celestial, positioned: !!sky?.positioned,
        positions: [], blendOffsets: [], normals: [], uvs: [], colors: [],
      };
      draws.push(d);
    }

    const n = prim.positions.length / 3;
    const order = mirrored ? [0, 2, 1] : [0, 1, 2];
    for (let t = 0; t + 2 < n; t += 3) {
      for (const k of order) {
        const i = t + k;
        const i3 = i * 3, i2 = i * 2, i4 = i * 4;
        const [wx, wy, wz] = mulPoint(matrix, prim.positions[i3], prim.positions[i3 + 1], prim.positions[i3 + 2]);
        const [nx, ny, nz] = mulDir(matrix, prim.normals[i3], prim.normals[i3 + 1], prim.normals[i3 + 2]);
        const [dx, dy, dz] = toDisplay(wx, wy, wz);
        const [dnx, dny, dnz] = toDisplay(nx, ny, nz);
        d.positions.push(dx, dy, dz);
        d.normals.push(dnx, dny, dnz);
        d.uvs.push(prim.uvs[i2], prim.uvs[i2 + 1]);
        d.colors.push(
          clamp255(prim.colors[i4]),
          clamp255(prim.colors[i4 + 1]),
          clamp255(prim.colors[i4 + 2]),
          clamp255(prim.colors[i4 + 3]),
        );
        if (wind) {
          // Wind delta is a direction: rotate/scale only, then flip like a normal.
          const [bx, by, bz] = mulDir(matrix, prim.blendOffsets[i3], prim.blendOffsets[i3 + 1], prim.blendOffsets[i3 + 2]);
          const [dbx, dby, dbz] = toDisplay(bx, by, bz);
          d.blendOffsets.push(dbx, dby, dbz);
        } else {
          d.blendOffsets.push(0, 0, 0);
        }
      }
      triCount += 1;
    }
  };

  const emitMesh = (meshName, matrix, layer = 'world') => {
    const prims = meshes.get(meshName);
    if (!prims) return;
    for (const prim of prims) emitPrim(meshName, prim, matrix, layer, null);
  };

  /** Emit a weather-folder sky shell (prims already resolved; not looked up by name). */
  const emitSkyPrims = (meshName, prims, dirWeather) => {
    for (const prim of prims) emitPrim(meshName, prim, IDENTITY, 'sky', dirWeather);
  };

  const envKindOf = (name) => {
    if (isWaterName(name)) return 'water';
    if (isSkyName(name)) return 'sky';
    return null;
  };

  // Placement list for the objects panel (display-space centers + bounds).
  const zonePlacements = [];
  const nameCounts = new Map();
  let skippedWild = 0;
  let skippedMissing = 0;
  const placedMeshes = new Set();

  let bminX = Infinity, bminY = Infinity, bminZ = Infinity;
  let bmaxX = -Infinity, bmaxY = -Infinity, bmaxZ = -Infinity;
  const expand = (bb) => {
    if (bb.min[0] < bminX) bminX = bb.min[0];
    if (bb.min[1] < bminY) bminY = bb.min[1];
    if (bb.min[2] < bminZ) bminZ = bb.min[2];
    if (bb.max[0] > bmaxX) bmaxX = bb.max[0];
    if (bb.max[1] > bmaxY) bmaxY = bb.max[1];
    if (bb.max[2] > bmaxZ) bmaxZ = bb.max[2];
  };

  const pushPlacement = (p, resolved, matrix, kind = null) => {
    const c = (nameCounts.get(p.meshId) || 0) + 1;
    nameCounts.set(p.meshId, c);
    const name = c === 1 ? p.meshId : `${p.meshId}.${String(c).padStart(3, '0')}`;
    const [dx, dy, dz] = toDisplay(p.pos[0], p.pos[1], p.pos[2]);
    const local = localBounds.get(resolved);
    const bounds = local ? transformBoundsDisplay(local, matrix) : {
      min: [dx - 1, dy - 1, dz - 1],
      max: [dx + 1, dy + 1, dz + 1],
    };
    if (!kind) expand(bounds); // camera fit from world geometry only
    zonePlacements.push({
      name,
      meshId: p.meshId,
      mesh: resolved,
      index: p.index ?? -1,
      instance: c,
      pos: [dx, dy, dz],
      rawPos: [p.pos[0], p.pos[1], p.pos[2]],
      rot: p.rot || [0, 0, 0],
      scale: p.scale || [1, 1, 1],
      bounds,
      kind, // null | 'sky' | 'water'
    });
  };

  // World geometry: 0x1C placements (skip env shells — they go on the env layer).
  for (const p of placements) {
    if (!isSanePlacement(p)) { skippedWild++; continue; }
    const resolved = resolveMeshName(p.meshId, meshes);
    if (!resolved) { skippedMissing++; continue; }
    placedMeshes.add(resolved);
    const kind = envKindOf(resolved);
    const matrix = trsMatrix(p.pos, p.rot, p.scale);
    if (kind) {
      emitMesh(resolved, matrix, kind);   // layer = 'sky' | 'water'
      pushPlacement(p, resolved, matrix, kind);
    } else {
      emitMesh(resolved, matrix, 'world');
      pushPlacement(p, resolved, matrix, null);
    }
  }

  // 0x05 effect geometry — water surfaces, spray, godrays, thunder — is no
  // longer baked here. Those generators are run live by the particle system
  // (ui/js/particle/), which evaluates their keyframe curves, UV scroll,
  // draw-distance fades and emission over time. Baking them meant guessing at
  // static values for animated properties, which is what all the removed
  // heuristics (alpha-0 skips, whiteTexMask, untextured-chroma guards) were
  // compensating for.

  // Weather-folder sky shells (weat/<id>/…): one entry per weather×mesh so each
  // weather keeps its own cloud texture (mist/clod/thdr all ship clod_a01, etc.).
  const weatherSky = parsed.weatherSky ?? [];
  const weatherSkyNames = new Set(weatherSky.map((e) => e.name));
  for (const entry of weatherSky) {
    if (placedMeshes.has(entry.name)) continue;
    emitSkyPrims(entry.name, entry.prims, entry.weather);
    const b = meshLocalBounds(entry.prims);
    if (b && !localBounds.has(entry.name)) localBounds.set(entry.name, b);
    const local = localBounds.get(entry.name);
    const bounds = local ? transformBoundsDisplay(local, IDENTITY) : {
      min: [-1, -1, -1], max: [1, 1, 1],
    };
    const label = entry.weather ? `${entry.name} (${entry.weather})` : entry.name;
    zonePlacements.push({
      name: label,
      meshId: entry.name,
      mesh: entry.name,
      index: -1,
      instance: 1,
      pos: [0, 0, 0],
      rawPos: [0, 0, 0],
      rot: [0, 0, 0],
      scale: [1, 1, 1],
      bounds,
      kind: 'sky',
    });
  }

  // Unplaced sky shells sit at the origin (engine wraps sky around camera). Unplaced
  // water without a surface effect is a bare template — skip it (it would be a speck).
  // Skip names already emitted from weatherSky so we don't double-draw.
  for (const name of meshes.keys()) {
    if (placedMeshes.has(name) || weatherSkyNames.has(name)) continue;
    const kind = envKindOf(name);
    if (kind !== 'sky') continue; // only unplaced sky; other unplaced meshes are VFX junk
    emitMesh(name, IDENTITY, kind);
    const local = localBounds.get(name);
    const bounds = local ? transformBoundsDisplay(local, IDENTITY) : {
      min: [-1, -1, -1], max: [1, 1, 1],
    };
    zonePlacements.push({
      name,
      meshId: name,
      mesh: name,
      index: -1,
      instance: 1,
      pos: [0, 0, 0],
      rawPos: [0, 0, 0],
      rot: [0, 0, 0],
      scale: [1, 1, 1],
      bounds,
      kind,
    });
  }

  // Freeze the ordered draw list into GPU-ready typed arrays. zBias mirrors xim:
  // blend submeshes get ZBiasLevel.High (5) → polygonOffset(-5, 1) at draw time.
  const zoneDraws = [];
  let vertexCount = 0;
  for (const d of draws) {
    const n = d.positions.length / 3;
    if (n < 3) continue;
    vertexCount += n;
    zoneDraws.push({
      layer: d.layer,
      textureName: d.texKey || null,
      blend: d.blend,
      noCull: d.noCull,
      discard: d.discard,
      wind: d.wind,
      weather: d.weather ?? null,
      celestial: !!d.celestial,
      positioned: !!d.positioned,
      surface: d.surface || null,
      uvScroll: d.uvScroll || null,
      zBias: d.blend ? 5 : 0,
      count: n,
      positions: new Float32Array(d.positions),
      blendOffsets: new Float32Array(d.blendOffsets),
      normals: new Float32Array(d.normals),
      uvs: new Float32Array(d.uvs),
      colors: new Uint8Array(d.colors),
    });
  }

  const outTextures = new Map();
  for (const [name, img] of texMap) {
    outTextures.set(name, {
      name,
      width: img.width,
      height: img.height,
      format: 'rgba32',
      data: img.rgba,
    });
  }

  // Group mesh types for the objects panel.
  // World groups first (by count), then env (sky/water) alphabetically.
  const byMesh = new Map();
  for (const p of zonePlacements) {
    const key = `${p.kind || 'world'}\0${p.mesh}`;
    let g = byMesh.get(key);
    if (!g) {
      g = { mesh: p.mesh, meshId: p.meshId, kind: p.kind || null, instances: [] };
      byMesh.set(key, g);
    }
    g.instances.push(p);
  }
  const objectGroups = [...byMesh.values()]
    .map((g) => ({ ...g, count: g.instances.length }))
    .sort((a, b) => {
      const ae = a.kind ? 1 : 0, be = b.kind ? 1 : 0;
      if (ae !== be) return ae - be;
      if (!a.kind && !b.kind) return b.count - a.count || a.mesh.localeCompare(b.mesh);
      return a.mesh.localeCompare(b.mesh);
    });

  const zoneBounds = isFinite(bminX) ? {
    min: [bminX, bminY, bminZ],
    max: [bmaxX, bmaxY, bmaxZ],
    footY: bminY,
  } : null;

  // Collision overlay: convert raw FFXI world coords → display (−x,−y,z).
  let collision = null;
  if (rawCollision?.positions?.length) {
    const src = rawCollision.positions;
    const positions = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
      const [dx, dy, dz] = toDisplay(src[i], src[i + 1], src[i + 2]);
      positions[i] = dx; positions[i + 1] = dy; positions[i + 2] = dz;
    }
    collision = {
      positions,
      colors: rawCollision.colors,
      triCount: rawCollision.triCount || (positions.length / 9),
    };
  }

  const model = {
    sourceName,
    kind: 'zone',
    skeleton: {
      joints: [{ parent: -1, rot: [0, 0, 0, 1], trans: [0, 0, 0] }],
      references: [],
    },
    // Zones bypass the entity mesh-group/skinning path entirely: the renderer
    // draws zoneDraws in order with per-draw GL state (xim GLDrawer.drawXim).
    meshGroups: [],
    zoneDraws,
    textures: outTextures,
    animations: [],
    schedules: [],
    info: null,
    zoneBounds,
    zonePlacements,
    objectGroups,
    collision,
    zoneStats: {
      meshCount: meshes.size,
      placementCount: zonePlacements.filter((p) => !p.kind).length,
      envCount: zonePlacements.filter((p) => p.kind).length,
      placementTotal: placements.length,
      skippedWild,
      skippedMissing,
      triCount: triCount | 0,
      vertexCount,
      drawCount: zoneDraws.length,
      textureCount: outTextures.size,
      objectTypes: objectGroups.length,
      collTris: collision?.triCount ?? 0,
    },
  };
  model.isRenderable = zoneDraws.length > 0;
  return model;
}

/** Strip leveleditor `game/` prefix → path relative to the install root. */
export function zoneDatRelPath(zonePath) {
  return String(zonePath || '')
    .replace(/^game[\\/]/i, '')
    .replace(/\//g, '\\');
}
