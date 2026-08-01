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
  constructor(ctx, sound, { looping, volume }) {
    const { buffer, loopStart = 0 } = sound;
    this.ctx = ctx;
    this.gain = ctx.createGain();
    this.gain.gain.value = volume;
    this.gain.connect(ctx.destination);

    this.source = ctx.createBufferSource();
    this.source.buffer = buffer;
    this.source.loop = looping;
    // Ambient beds open with an intro that plays once; the file says where the
    // repeating body starts. Looping the whole buffer replays that intro every
    // cycle, which is the blip you don't hear in game.
    if (looping && loopStart > 0 && loopStart < buffer.duration) {
      this.source.loopStart = loopStart;
      this.source.loopEnd = buffer.duration;
    }
    this.source.connect(this.gain);
    this.stopped = false;
    this.source.onended = () => { this.stopped = true; };
    this.source.start();
  }

  /** Snap gain immediately — cancels any in-flight fade/ramp. */
  setVolume(v) {
    if (this.stopped) return;
    const now = this.ctx.currentTime;
    const g = this.gain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(Math.max(0, v), now);
  }

  fadeTo(target, seconds) {
    if (this.stopped) return;
    const now = this.ctx.currentTime;
    const g = this.gain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(Math.max(0, target), now + Math.max(0.001, seconds));
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
 * @param {(relPath: string) => Promise<{buffer: AudioBuffer, loopStart: number}|null>} opts.loadSound
 *        loopStart is in seconds; 0 means "loop the whole buffer".
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
    this._buffers = new Map();   // soundId -> { buffer, loopStart } | null
    this._lastKey = null;
    // Voices mid-crossfade are detached from _current so a mute/stop must still
    // reach them — otherwise "toggle off" leaves the fading bed audible.
    this._fading = [];
    // Every one-shot handed out by play(). Without this, stopAll() only silenced
    // the ambient bed and a fired one-shot ran to completion no matter what —
    // so switching effect (or view) left the previous effect's sounds playing
    // over the new one, which reads as a sound firing at a wild delay.
    this._oneShots = [];
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
    // 0 must be silent immediately — setTarget ramps fight in-flight fadeTo.
    this._current?.voice.setVolume(this.volume);
    for (const voice of this._fading) voice.setVolume(0);
    for (const h of this._oneShots) h.setMasterVolume?.(this.volume);
    // Volume 0: stop the bed so nothing is decoding/mixing under the floor.
    if (this.volume <= 0 && this._current) {
      this._current.voice.stop();
      this._current = null;
      this._lastKey = null;
    }
  }

  stopAll() {
    this._current?.voice.stop();
    this._current = null;
    this._lastKey = null;
    this._pending = null;
    for (const voice of this._fading) voice.stop();
    this._fading.length = 0;
    this.stopOneShots();
  }

  /**
   * Cancel every one-shot without touching the ambient bed — what changing the
   * effect (or its schedule) needs, so the outgoing effect takes its sounds with
   * it. Covers both routine-scheduled sounds and particle-attached emitters,
   * since every voice is handed out by play(). Handles whose buffer is still
   * decoding are cancelled too: the `stopped` flag makes play() drop them when
   * the decode lands.
   */
  stopOneShots() {
    for (const h of this._oneShots) h.stop();
    this._oneShots.length = 0;
  }

  /**
   * Pick the ambient sound for the current weather and hour, cross-fading when
   * it changes. Cheap to call every frame — it early-outs unless the choice
   * actually moved.
   */
  update() {
    this._fading = this._fading.filter((v) => !v.isComplete());
    if (!this.enabled || this.volume <= 0 || !this.system || !this.environment) return;

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
      this._fading.push(previous.voice);
    }
    this._current = null;
    if (soundId == null || this.volume <= 0) return;

    this._pending = soundId;
    const sound = await this._buffer(soundId);
    // A newer switch landed while this was decoding.
    if (this._pending !== soundId || !sound || !this.enabled || this.volume <= 0) return;

    const ctx = this.getContext?.();
    if (!ctx) return;
    const voice = new Voice(ctx, sound, { looping: true, volume: 0 });
    voice.fadeTo(this.volume, 3.33);
    this._current = { soundId, voice };
  }

  /**
   * Pre-decode a sound so its first play() starts on the scheduled frame. A
   * cold one-shot pays file read + decode at fire time — enough lag to make a
   * correctly-timed impact sound land audibly late.
   */
  warm(soundId) { return this._buffer(soundId); }

  async _buffer(soundId) {
    if (this._buffers.has(soundId)) return this._buffers.get(soundId);
    let sound = null;
    try {
      sound = await this.loadSound(soundPath(soundId));
    } catch {
      sound = null;
    }
    this._buffers.set(soundId, sound);
    return sound;
  }

  /**
   * ParticleSystem.playSoundEffect hook: a particle-attached one-shot or loop
   * with distance attenuation supplied by the caller. Callers that pass
   * volumeFn should keep calling handle.setAttenuation each frame so volume
   * tracks the camera.
   */
  play(soundPointer, association, { looping = false, positionFn = null, volumeFn = null } = {}) {
    if (!this.enabled || this.volume <= 0 || !soundPointer) return null;

    const backend = this;
    const applyVol = (h) => {
      if (h.stopped || !h.voice) return;
      h.voice.setVolume(h.masterVolume * h.attenuation);
    };
    const handle = {
      voice: null,
      stopped: false,
      masterVolume: backend.volume,
      attenuation: 1,
      stop() { this.voice?.stop(); this.stopped = true; },
      isComplete() { return this.stopped || (this.voice ? this.voice.isComplete() : false); },
      setMasterVolume(v) {
        this.masterVolume = v;
        applyVol(this);
      },
      setAttenuation(a) {
        this.attenuation = Math.max(0, a);
        if (this.attenuation <= 0 && this.voice) {
          this.voice.stop();
          this.stopped = true;
          return;
        }
        applyVol(this);
      },
    };

    this._buffer(soundPointer.soundId).then((sound) => {
      if (!sound || handle.stopped || !backend.enabled || backend.volume <= 0) return;
      const ctx = backend.getContext?.();
      if (!ctx) return;
      const attenuation = volumeFn ? (volumeFn(positionFn?.()) ?? 1) : 1;
      if (attenuation <= 0) return; // leave handle alive so AudioEmitter can retry when closer
      handle.attenuation = attenuation;
      handle.masterVolume = backend.volume;
      handle.voice = new Voice(ctx, sound, {
        looping,
        volume: handle.masterVolume * handle.attenuation,
      });
    });

    this._oneShots = this._oneShots.filter((h) => !h.isComplete());
    this._oneShots.push(handle);
    return handle;
  }
}
