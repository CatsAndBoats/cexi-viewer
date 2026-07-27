// Weather + particle audio — port of xim EnvironmentManager.updateWeatherAudioEffect
// and the AudioManager side of AudioEmitter.
//
// A weather directory holds numerically-named SoundPointerResources (0x3D), one
// per time of day. The active one is the latest whose id is <= the current HHMM,
// looping, and it cross-fades whenever the weather or the hour changes — that is
// the wind/rain/surf bed you hear standing in a zone, and where thunder claps
// come from.
//
// Sound ids map to <root>/sound/win/se/seNNN/seNNNNNN.spw.

import { SEC } from '../dat/tree.js';

export const soundPath = (soundId) => {
  const folder = String(Math.floor(soundId / 1000)).padStart(3, '0');
  const file = String(soundId).padStart(6, '0');
  return `sound\\win\\se\\se${folder}\\se${file}.spw`;
};

/** A single playing sound with an independent gain ramp. */
class Voice {
  constructor(ctx, buffer, { looping, volume }) {
    this.ctx = ctx;
    this.gain = ctx.createGain();
    this.gain.gain.value = volume;
    this.gain.connect(ctx.destination);

    this.source = ctx.createBufferSource();
    this.source.buffer = buffer;
    this.source.loop = looping;
    this.source.connect(this.gain);
    this.stopped = false;
    this.source.onended = () => { this.stopped = true; };
    this.source.start();
  }

  setVolume(v) {
    if (this.stopped) return;
    this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  fadeTo(target, seconds) {
    if (this.stopped) return;
    const now = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(this.gain.gain.value, now);
    this.gain.gain.linearRampToValueAtTime(target, now + seconds);
  }

  stopAfter(seconds = 0) {
    if (this.stopped) return;
    try { this.source.stop(this.ctx.currentTime + seconds); } catch { /* already stopped */ }
  }

  stop() {
    if (this.stopped) return;
    try { this.source.stop(); } catch { /* already stopped */ }
    this.stopped = true;
  }

  isComplete() { return this.stopped; }
}

/**
 * Plays the ambient bed for the active weather, and backs particle-attached
 * sounds. Decoding is delegated so this module stays free of the app's file and
 * codec plumbing.
 *
 * @param {Object} opts
 * @param {() => AudioContext} opts.getContext
 * @param {(relPath: string) => Promise<AudioBuffer|null>} opts.loadSound
 */
export class WeatherAudio {
  constructor({ getContext, loadSound, volume = 0.6 }) {
    this.getContext = getContext;
    this.loadSound = loadSound;
    this.volume = volume;
    this.enabled = false;

    this.system = null;
    this.environment = null;

    this._current = null;        // { soundId, voice }
    this._pending = null;        // soundId currently being loaded
    this._buffers = new Map();   // soundId -> AudioBuffer | null
    this._lastKey = null;
  }

  attach(system, environment) {
    this.stopAll();
    this.system = system;
    this.environment = environment;
    if (system) system.audioBackend = this;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!this.enabled) this.stopAll();
    else this._lastKey = null;    // force a re-pick on the next update
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    this._current?.voice.setVolume(this.volume);
  }

  stopAll() {
    this._current?.voice.stop();
    this._current = null;
    this._lastKey = null;
  }

  /**
   * Pick the ambient sound for the current weather and hour, cross-fading when
   * it changes. Cheap to call every frame — it early-outs unless the choice
   * actually moved.
   */
  update() {
    if (!this.enabled || !this.system || !this.environment) return;

    const weather = this.environment.getWeather();
    const dir = this.system.getWeatherDirectory(weather);
    if (!dir) return;

    const hhmm = this.environment.clock.currentHour() * 100 + this.environment.clock.currentMinuteOfHour();
    const key = `${weather}\0${this._todBucket(dir, hhmm)}`;
    if (key === this._lastKey) return;
    this._lastKey = key;

    const pointer = this._pickForTimeOfDay(dir, hhmm);
    const soundId = pointer?.soundId ?? null;
    if (soundId === (this._current?.soundId ?? null)) return;

    this._crossFadeTo(soundId);
  }

  /**
   * xim getTimeOfDayResource: the latest numerically-named sound whose id is at
   * or before now, wrapping to the last one when the day has just started.
   */
  _pickForTimeOfDay(dir, hhmm) {
    const pointers = dir.collectByType(SEC.SOUND_POINTER)
      .filter((p) => /^\d+$/.test(String(p.id ?? '')));
    if (!pointers.length) return null;

    const numeric = pointers.map((p) => ({ p, n: Number(p.id) }));
    const eligible = numeric.filter((e) => e.n <= hhmm);
    const pick = eligible.length
      ? eligible.reduce((a, b) => (b.n > a.n ? b : a))
      : numeric.reduce((a, b) => (b.n > a.n ? b : a));
    return pick.p;
  }

  _todBucket(dir, hhmm) {
    const pointer = this._pickForTimeOfDay(dir, hhmm);
    return pointer?.id ?? '';
  }

  async _crossFadeTo(soundId) {
    const previous = this._current;
    if (previous) {
      previous.voice.fadeTo(0, 3.33);
      previous.voice.stopAfter(3.4);
    }
    this._current = null;
    if (soundId == null) return;

    this._pending = soundId;
    const buffer = await this._buffer(soundId);
    // A newer switch landed while this was decoding.
    if (this._pending !== soundId || !buffer || !this.enabled) return;

    const ctx = this.getContext?.();
    if (!ctx) return;
    const voice = new Voice(ctx, buffer, { looping: true, volume: 0 });
    voice.fadeTo(this.volume, 3.33);
    this._current = { soundId, voice };
  }

  async _buffer(soundId) {
    if (this._buffers.has(soundId)) return this._buffers.get(soundId);
    let buffer = null;
    try {
      buffer = await this.loadSound(soundPath(soundId));
    } catch {
      buffer = null;
    }
    this._buffers.set(soundId, buffer);
    return buffer;
  }

  /**
   * ParticleSystem.playSoundEffect hook: a particle-attached one-shot or loop
   * with distance attenuation supplied by the caller.
   */
  play(soundPointer, association, { looping = false, positionFn = null, volumeFn = null } = {}) {
    if (!this.enabled || !soundPointer) return null;

    const handle = {
      voice: null,
      stopped: false,
      stop() { this.voice?.stop(); this.stopped = true; },
      isComplete() { return this.stopped || (this.voice ? this.voice.isComplete() : false); },
    };

    this._buffer(soundPointer.soundId).then((buffer) => {
      if (!buffer || handle.stopped || !this.enabled) return;
      const ctx = this.getContext?.();
      if (!ctx) return;
      const attenuation = volumeFn ? (volumeFn(positionFn?.()) ?? 1) : 1;
      if (attenuation <= 0) { handle.stopped = true; return; }
      handle.voice = new Voice(ctx, buffer, { looping, volume: this.volume * attenuation });
    });

    return handle;
  }
}
