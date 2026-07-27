// ParticleSystem — the host that xim spreads across MainTool, SceneManager,
// ParticleMeshResolver and GlobalDirectory.
//
// It owns the zone's DAT tree, the shared ROM/0/0.DAT effects tree, the
// EffectManager, and the resolution rules that turn a DatId inside a generator
// into an actual mesh / curve / sound. Everything the ops call through
// `particle.runtime` lands here.

import { Vec3, Mat4 } from './math.js';
import { SEC } from '../dat/tree.js';
import { LinkedDataType } from './types.js';
import { EffectManager, ZoneAssociation, WeatherAssociation } from './effects.js';
import { ParticleGenerator } from './runtime.js';

// ── mesh providers (xim ParticleLinkedDataProviders) ───────────────────────

class StaticMeshProvider {
  constructor(meshes, isParticleMesh) { this.meshes = meshes; this.isParticleMesh = isParticleMesh; }
  hasMeshes() { return this.meshes.length > 0; }
  getMeshes() { return this.meshes; }
}

class SpriteSheetMeshProvider {
  constructor(spriteSheet) { this.spriteSheet = spriteSheet; this.isParticleMesh = true; }
  hasMeshes() { return this.spriteSheet.meshes.length > 0; }
  getMeshes(particle) {
    const i = Math.min(this.spriteSheet.meshes.length - 1, Math.max(0, particle.spriteSheetIndex));
    return [this.spriteSheet.meshes[i]];
  }
}

class NoMeshProvider {
  hasMeshes() { return false; }
  getMeshes() { return []; }
}

const NO_MESH = new NoMeshProvider();

/**
 * A particle-attached sound. xim plays it through AudioManager with a distance
 * falloff and an optional path so shoreline waves follow the coast.
 */
class AudioEmitter {
  constructor(system, soundPointer) { this.system = system; this.soundPointer = soundPointer; }

  update(particle) {
    if (!this.soundPointer) return;
    const volume = this.#volume(this.#position(particle), particle);
    const shouldCull = volume != null && volume <= 0;

    if (!shouldCull && particle.emittedAudio.length === 0) {
      const handle = this.system.playSoundEffect(this.soundPointer, particle.association, {
        looping: particle.audioConfiguration.looping,
        positionFn: () => this.#position(particle),
        volumeFn: (pos) => this.#volume(pos, particle),
      });
      if (handle) particle.emittedAudio.push(handle);
    }

    if (shouldCull) {
      for (const a of particle.emittedAudio) a.stop();
      particle.emittedAudio = particle.emittedAudio.filter((a) => !a.isComplete());
    }
  }

  #position(particle) {
    const path = particle.audioConfiguration.pathLink?.getIfPresent();
    if (path) {
      const nearest = path.nearestPoint(this.system.camera.getPosition());
      if (nearest) return nearest.point;
    }
    return particle.getWorldSpacePosition();
  }

  #volume(position, particle) {
    if (!position) return 0;
    const cfg = particle.audioConfiguration;
    if (cfg.farDistance <= 0) return null;
    const distance = Vec3.distance(position, this.system.camera.getPosition());
    const fall = distance <= cfg.nearDistance ? 1
      : distance >= cfg.farDistance ? 0
        : (cfg.farDistance - distance) / (cfg.farDistance - cfg.nearDistance);
    return cfg.volumeMultiplier * fall;
  }
}

// ── the system ─────────────────────────────────────────────────────────────

export class ParticleSystem {
  /**
   * @param {Object} opts
   * @param {Object} opts.zoneRoot     DatDir for the zone DAT
   * @param {Object} [opts.globalRoot] DatDir for ROM/0/0.DAT (shared effects)
   * @param {Map}    [opts.zoneMeshIdToName] 0x2E DatId -> mesh name
   * @param {Map}    [opts.zoneMeshes]       mesh name -> prim[]
   * @param {Object} opts.camera       adapter, see CameraAdapter below
   * @param {Object} opts.environment  EnvironmentManager
   */
  constructor({ zoneRoot, globalRoot = null, zoneMeshIdToName = new Map(), zoneMeshes = new Map(), camera, environment, onWarn = null }) {
    this.zoneRoot = zoneRoot;
    // xim's rootDirectory is the DAT's first pushed directory (f_qu, …), not a
    // synthetic wrapper — link resolution walks up to exactly that.
    this.areaRoot = zoneRoot?.getSubDirectories()[0] ?? zoneRoot;
    this.globalRoot = globalRoot;
    this.zoneMeshIdToName = zoneMeshIdToName;
    this.zoneMeshes = zoneMeshes;
    this.camera = camera;
    this.environment = environment;
    this.effectManager = new EffectManager();

    this._warnings = new Map();
    this._onWarn = onWarn;
    this._meshCache = new Map();
    this._screenFlashes = [];
    this._cameraShake = 0;

    this.audioBackend = null;    // set by the host to enable weather/particle audio
    this.floorQuery = null;      // set by the host for decal / ground projection
  }

  warn(msg) {
    const n = (this._warnings.get(msg) ?? 0) + 1;
    this._warnings.set(msg, n);
    if (n === 1) this._onWarn?.(msg);
  }

  getWarnings() { return [...this._warnings].map(([msg, count]) => ({ msg, count })); }

  // ── registration (xim Area.registerEffects) ──────────────────────────────

  /**
   * Register every auto-running generator in the zone's `effe` and `mode`
   * directories under the zone association. These are the always-on effects:
   * water surfaces, shoreline spray, fountains, torches.
   */
  registerZoneEffects() {
    const association = ZoneAssociation();
    const effectRoot = this.areaRoot?.getNullableSubDirectory('data') ?? this.areaRoot;
    if (!effectRoot) return 0;

    let n = 0;
    for (const dirId of ['effe', 'mode']) {
      const dir = effectRoot.getNullableSubDirectory(dirId);
      if (!dir) continue;
      for (const effect of dir.collectByTypeRecursive(SEC.EFFECT)) {
        if (!effect.def.autoRun) continue;
        this.effectManager.register(association, this.createGenerator(effect, association));
        n++;
      }
    }
    return n;
  }

  /**
   * Register the generators belonging to one weather type (xim
   * EnvironmentManager.updateWeatherEffects). Unlike zone effects these are
   * registered whether or not they auto-run — the weather directory only
   * contains effects that are meant to be live while that weather is active.
   */
  registerWeatherEffects(weatherId) {
    const dir = this.getWeatherDirectory(weatherId);
    if (!dir) return 0;
    const association = WeatherAssociation(weatherId);
    let n = 0;
    for (const effect of dir.collectByTypeRecursive(SEC.EFFECT)) {
      this.effectManager.register(association, this.createGenerator(effect, association));
      n++;
    }
    return n;
  }

  getWeatherDirectory(weatherId) {
    const weat = this.areaRoot?.getNullableSubDirectory('weat');
    return weat?.getNullableSubDirectory(weatherId) ?? null;
  }

  /** Weather ids this zone actually ships, in DAT order. */
  listWeatherTypes() {
    const weat = this.areaRoot?.getNullableSubDirectory('weat');
    return weat ? weat.getSubDirectories().map((d) => d.id) : [];
  }

  createGenerator(effectResource, association, maxEmitTime = Infinity, parent = null) {
    return new ParticleGenerator(this, effectResource, association, maxEmitTime, parent);
  }

  // ── per-frame ────────────────────────────────────────────────────────────

  update(elapsedFrames) {
    this._screenFlashes.length = 0;
    this._cameraShake = 0;
    this.effectManager.update(elapsedFrames);
  }

  getAllParticles() { return this.effectManager.getAllParticles(); }
  getScreenFlashes() { return this._screenFlashes; }
  getCameraShake() { return this._cameraShake; }

  addScreenFlash(color) { this._screenFlashes.push(color); }
  applyCameraShake(amount) { this._cameraShake = Math.max(this._cameraShake, Math.abs(amount)); }

  newMat4() { return new Mat4(); }

  // ── resolution (xim ParticleMeshResolver + DatLink search order) ─────────

  resolveMesh(linkedDataType, link, generator) {
    switch (linkedDataType) {
      case LinkedDataType.StaticMesh: return this.#resolveStaticMesh(link, generator);
      case LinkedDataType.SpriteSheet:
      case LinkedDataType.LensFlare: return this.#resolveSpriteSheet(link, generator);
      // Ring meshes, distortion, weighted meshes, point lights and audio have no
      // drawable geometry in this viewer yet; they resolve to nothing and are
      // skipped at draw time rather than erroring the generator.
      default: return NO_MESH;
    }
  }

  #resolveStaticMesh(link, generator) {
    const dir = generator.localDir;
    const resource = link.getOrPut((id) => (
      dir?.searchLocalAndParents(id, SEC.PARTICLE_MESH)
      ?? this.#zoneMeshById(id)
      ?? dir?.root().getChildRecursive(id, SEC.PARTICLE_MESH)
      ?? this.globalRoot?.getChildRecursive(id, SEC.PARTICLE_MESH)
      ?? null
    ));

    if (!resource) {
      this.warn(`[${generator.datId}] static mesh not found: ${link.id}`);
      return NO_MESH;
    }

    const cached = this._meshCache.get(resource);
    if (cached) return cached;

    const provider = resource.kind === 'particleMesh'
      ? new StaticMeshProvider(resource.meshes, true)
      : new StaticMeshProvider(resource.meshes, false);
    this._meshCache.set(resource, provider);
    return provider;
  }

  /**
   * Zone meshes (0x2E) are decrypted by the zone loader, not the DAT tree, so
   * they're bridged in by DatId here. This is what lets `t001 -> quf1` find
   * Qufim's ocean plane.
   */
  #zoneMeshById(id) {
    const name = this.zoneMeshIdToName.get(id) ?? this.zoneMeshIdToName.get(id.trim());
    if (!name) return null;
    const prims = this.zoneMeshes.get(name);
    if (!prims?.length) return null;
    return { kind: 'zoneMesh', id, name, meshes: prims.map(primToMesh) };
  }

  #resolveSpriteSheet(link, generator) {
    const dir = generator.localDir;
    const resource = link.getOrPut((id) => (
      dir?.getChildRecursive(id, SEC.SPRITE_SHEET)
      ?? dir?.root().getChildRecursive(id, SEC.SPRITE_SHEET)
      ?? this.globalRoot?.getChildRecursive(id, SEC.SPRITE_SHEET)
      ?? null
    ));

    if (!resource) {
      this.warn(`[${generator.datId}] sprite sheet not found: ${link.id}`);
      return NO_MESH;
    }

    const cached = this._meshCache.get(resource);
    if (cached) return cached;
    const provider = new SpriteSheetMeshProvider(resource);
    this._meshCache.set(resource, provider);
    return provider;
  }

  /** xim getKeyFrameReference: local child, then anywhere in the DAT. */
  resolveKeyFrame(id, generator) {
    const dir = generator.localDir;
    const found = dir?.getChild(id, SEC.KEYFRAME)
      ?? dir?.findFirstInEntireTree(id, SEC.KEYFRAME)
      ?? this.globalRoot?.getChildRecursive(id, SEC.KEYFRAME)
      ?? null;
    if (!found) this.warn(`[${generator.datId}] keyframe not found: ${id}`);
    return found;
  }

  resolveEffect(id, generator) {
    const dir = generator.localDir;
    return dir?.getChildRecursive(id, SEC.EFFECT)
      ?? dir?.root().getChildRecursive(id, SEC.EFFECT)
      ?? this.globalRoot?.getChildRecursive(id, SEC.EFFECT)
      ?? null;
  }

  resolvePointList(id, generator) {
    const dir = generator.localDir;
    return dir?.getChild(id, SEC.POINT_LIST)
      ?? dir?.findFirstInEntireTree(id, SEC.POINT_LIST)
      ?? this.globalRoot?.getChildRecursive(id, SEC.POINT_LIST)
      ?? null;
  }

  resolvePath(id, generator) {
    return generator.localDir?.searchLocalAndParents(id, SEC.PATH) ?? null;
  }

  resolveSoundPointer(id, generator) {
    return generator.localDir?.searchLocalAndParents(id, SEC.SOUND_POINTER)
      ?? this.globalRoot?.getChildRecursive(id, SEC.SOUND_POINTER)
      ?? null;
  }

  createAudioEmitter(link, generator) {
    const pointer = link.getOrPut((id) => this.resolveSoundPointer(id, generator));
    if (!pointer) this.warn(`[${generator.datId}] particle audio not found: ${link.id}`);
    return new AudioEmitter(this, pointer);
  }

  playSoundEffect(soundPointer, association, opts) {
    return this.audioBackend?.play(soundPointer, association, opts) ?? null;
  }

  // ── environment bridges ──────────────────────────────────────────────────

  getFullDayInterpolation() { return this.environment?.getFullDayInterpolation() ?? 0.5; }
  getDayOfWeek() { return this.environment?.getDayOfWeek() ?? 0; }
  getMoonPhase() { return this.environment?.getMoonPhase() ?? 6; }
  getModelLighting(environmentId) { return this.environment?.getModelLighting(environmentId) ?? null; }
  getSunPosition() { return this.environment?.getSunPosition() ?? new Vec3(0, 900, 0); }
  getMoonPosition() { return this.environment?.getMoonPosition() ?? new Vec3(0, -900, 0); }

  /** Which sub-environment the viewer is standing in; null means "outdoors". */
  getViewerEnvironmentId() { return null; }

  getCullReferencePosition() { return this.camera.getPosition(); }

  getNearestFloorY(position) { return this.floorQuery ? this.floorQuery(position) : null; }
}

/** Convert a zone.js prim into the uniform mesh descriptor the drawer expects. */
function primToMesh(prim) {
  const count = prim.positions.length / 3;
  const colors = new Uint8Array(count * 4);
  for (let i = 0; i < count * 4; i++) {
    colors[i] = Math.max(0, Math.min(255, Math.round(prim.colors[i] * 255)));
  }
  return {
    count,
    positions: prim.positions,
    normals: prim.normals,
    uvs: prim.uvs,
    colors,
    textureName: prim.textureName,
    noCull: prim.noCull,
    _zonePrim: prim,
  };
}

export { ZoneAssociation, WeatherAssociation };
