import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@headlessui/react';
import { backend } from '../js/backend.js';
import { animDisplayName, groupAnimations, mergeModels, parseEntity, resolveScheduleClip } from '../js/dat.js';
import { Renderer } from '../js/renderer.js';
import { FileTree } from './FileTree.jsx';
import { MenuBar } from './MenuBar.jsx';
import { NpcList } from './NpcList.jsx';
import { CharacterList, useCharacter } from './CharacterList.jsx';
import { AnimationPanel } from './AnimationPanel.jsx';
import { Combo } from './Combo.jsx';
import { MusicList, useAudioPlayer } from './MusicList.jsx';
import { MusicPlayer } from './MusicPlayer.jsx';
import { SfxList } from './SfxList.jsx';
import { SceneList } from './SceneList.jsx';
import { ZoneList } from './ZoneList.jsx';
import { PlacementPanel } from './PlacementPanel.jsx';
import { LoadingOverlay } from './LoadingOverlay.jsx';
import { SettingsModal } from './SettingsModal.jsx';
import { ExportModal } from './ExportModal.jsx';
import { DetailsPanel } from './DetailsPanel.jsx';
import { SkeletonPanel } from './SkeletonPanel.jsx';
import { TextureModal } from './TextureModal.jsx';
import { HelpModal } from './HelpModal.jsx';
import { parseFloorTexture } from '../js/dat.js';
import { extractKeyTables, parseZone, parseDatTextures } from '../js/zone.js';
import { zoneDatRelPath, zoneToModel } from '../js/zoneModel.js';
import { parseEnvironments, parseEnvironmentsByRoot, resolveEnvironment, defaultWeather, listWeathers, terrainLightingFromEnv, skyDomeFromEnv, EnvironmentManager } from '../js/environment.js';
import { parseSections } from '../js/zone.js';
import { buildDatTree, SEC } from '../js/dat/tree.js';
import { makeParsers } from '../js/dat/sections.js';
import { parseParticleGenerator } from '../js/particle/parser.js';
import { ParticleSystem } from '../js/particle/system.js';
import { WeatherAudio } from '../js/particle/audio.js';
import { toAudioBuffer, parseAudioHeader, FMT_ATRAC3 } from '../js/audio.js';
import { parseImageDat, textureForSet } from '../js/images.js';
import { ImageList } from './ImageList.jsx';
import { ImageSetPanel } from './ImageSetPanel.jsx';
import { ImageViewer } from './ImageViewer.jsx';
import { WeatherPanel } from './WeatherPanel.jsx';
import { Tooltip } from './Tooltip.jsx';
import { loadZoneNavmesh } from '../js/navmesh.js';

const DEFAULT_DAT_SUFFIX = 'ROM\\5\\3.DAT';
const DEFAULT_BG = '#303438';
const LAST_DAT_KEY = 'lastDat';
const LAST_VIEW_KEY = 'lastView';
const LAST_IMAGE_KEY = 'lastImage';
const ANIM_SEL_KEY = 'lastAnimSel';
const VIEWS = ['files', 'npc', 'pc', 'music', 'sfx', 'scene', 'zones', 'images'];
/** Views that browse individual models, where fly controls are a hindrance. */
const ORBIT_VIEWS = new Set(['files', 'npc', 'pc']);
// Zones and Scene are two panels onto the same loaded zone, so moving between
// them keeps it. Every other view change is a fresh page: whatever the last one
// had running gets torn down.
const ZONE_VIEWS = new Set(['zones', 'scene']);
// The only views that own the audio player. A zone's BGM plays through the same
// player, so leaving Zones has to stop it too — hence "was it an audio view",
// not just "is it one now".
const AUDIO_VIEWS = new Set(['music', 'sfx']);

// A schedule sequence lays segments on a timeline; a joint whose segment hasn't
// started yet would show bind pose (T-pose flash each loop). Underlay a looping
// idle so those joints rest naturally — battle idle for weapon actions if it's
// loaded, otherwise plain idle (falling back to std).
function pickBaseIdle(model) {
  const grouped = groupAnimations(model.animations);
  for (const id of ['btl', 'idl', 'std']) {
    const g = grouped.find((x) => x.id === id);
    if (g && g.clip.jointTracks.size > 0) return g.clip;
  }
  return null;
}

function scheduleClip(model, sched) {
  const clip = resolveScheduleClip(model, sched);
  if (clip?.segments) {
    const base = pickBaseIdle(model);
    if (base) clip.baseClip = base;
  }
  return clip;
}

/**
 * Yield so the loading overlay can paint before a long synchronous step.
 *
 * requestAnimationFrame alone deadlocks when the page isn't compositing — a
 * backgrounded tab, or a hidden panel — leaving the load stuck on whatever step
 * it had just announced. The timer is the escape hatch: whichever fires first
 * wins, so a visible page still yields on the frame boundary.
 */
const yieldToPaint = () => new Promise((resolve) => {
  let done = false;
  const finish = () => { if (!done) { done = true; resolve(); } };
  requestAnimationFrame(finish);
  setTimeout(finish, 100);
});

const loadSettings = (gamePath) => ({
  gamePath,
  bgColor: localStorage.getItem('bgColor') || DEFAULT_BG,
  autoPlay: localStorage.getItem('autoPlay') !== '0',
  autoWasdZones: localStorage.getItem('autoWasdZones') !== '0',
  cexiPath: localStorage.getItem('cexiPath') || '',
});

export default function App() {
  const canvasRef = useRef(null);
  const rendererRef = useRef(null);
  const modelRef = useRef(null);
  const loadGenRef = useRef(0);       // drop stale async load results
  const overlayGenRef = useRef(0);    // which load gen owns the loading overlay
  const appliedPlayRef = useRef({ kind: null, id: '' }); // last applied anim/schedule (gear-swap resume)
  const settingsRef = useRef(null);
  const animsRef = useRef([]);
  const sourcePathRef = useRef('');
  // The DAT the status bar names, at its real casing — selectedDat is folded to
  // lower case for the tree's matching and isn't safe to hand a case-sensitive
  // filesystem. For composed characters this is the changed slot, not the last
  // DAT merged, so "show in Explorer" lands on what the user is reading.
  const shownPathRef = useRef('');
  const drag = useRef({ btn: -1, x: 0, y: 0 });
  const heldKeys = useRef(new Set());
  const wasdRef = useRef(localStorage.getItem('wasd') === '1');

  const [settings, setSettings] = useState(null);
  const [wasd, setWasdState] = useState(() => localStorage.getItem('wasd') === '1');
  const setWasd = useCallback((on) => {
    const next = !!on;
    wasdRef.current = next;
    setWasdState(next);
    try { localStorage.setItem('wasd', next ? '1' : '0'); } catch { /* quota */ }
    const cam = rendererRef.current?.camera;
    if (cam) cam.setMode(next ? 'fly' : 'orbit');
  }, []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [exportSpec, setExportSpec] = useState(null);
  const [leftView, setLeftViewState] = useState(() => {
    const v = localStorage.getItem(LAST_VIEW_KEY);
    return VIEWS.includes(v) ? v : 'files';
  });
  const setLeftView = useCallback((v) => {
    setLeftViewState(v);
    localStorage.setItem(LAST_VIEW_KEY, v);
  }, []);
  // Browsing single models rather than a zone: fly controls put the camera
  // somewhere arbitrary and WASD swallows typing in the filter boxes, so drop
  // back to orbit on arrival. Only fires on a view change, so turning WASD back
  // on while you are in one of these views sticks.
  useEffect(() => {
    if (ORBIT_VIEWS.has(leftView) && wasdRef.current) setWasd(false);
  }, [leftView, setWasd]);
  // Left explorer panel (zones/files/…); toolbar toggle, persisted.
  const [explorerOpen, setExplorerOpen] = useState(() => localStorage.getItem('explorer') !== '0');
  const [statusText, setStatusText] = useState('');       // secondary detail/stats
  const [modelPath, setModelPath] = useState('');         // primary path of the loaded model
  const [anims, setAnims] = useState([]);        // grouped: [{ id, clip }]
  const [currentAnim, setCurrentAnim] = useState('');
  // Last picked animation/schedule — restored on launch and kept across gear
  // swaps (the actor reloads, the user's choice shouldn't reset to idle).
  const animSelRef = useRef((() => {
    try { return JSON.parse(localStorage.getItem(ANIM_SEL_KEY) || 'null') ?? {}; } catch { return {}; }
  })());
  const rememberAnimSel = (sel) => {
    animSelRef.current = sel;
    try { localStorage.setItem(ANIM_SEL_KEY, JSON.stringify(sel)); } catch { /* quota */ }
  };
  const [schedules, setSchedules] = useState([]);      // 0x07 routines
  const [currentSchedule, setCurrentSchedule] = useState('');
  const [modelInfo, setModelInfo] = useState(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [skeletonOpen, setSkeletonOpen] = useState(false);
  const [texWindows, setTexWindows] = useState([]); // [{ id, tex }] open texture viewers
  const texIdRef = useRef(0);
  const [selectedFloor, setSelectedFloor] = useState('');
  const [playing, setPlayingState] = useState(false);
  // Animation playback rate, 0.1–2.0 (10%–200%). Mirrored to a ref so the
  // renderer-lifecycle effect can seed a freshly-built renderer without listing
  // it as a dependency (which would rebuild the renderer on every speed change).
  const [playbackSpeed, setPlaybackSpeedState] = useState(() => {
    const v = parseFloat(localStorage.getItem('playbackSpeed'));
    return Number.isFinite(v) && v >= 0.1 && v <= 2 ? v : 1;
  });
  const playbackSpeedRef = useRef(playbackSpeed);
  const setPlaybackSpeed = useCallback((v) => {
    const clamped = Math.min(2, Math.max(0.1, v));
    playbackSpeedRef.current = clamped;
    setPlaybackSpeedState(clamped);
    try { localStorage.setItem('playbackSpeed', String(clamped)); } catch { /* quota */ }
    if (rendererRef.current) rendererRef.current.playbackSpeed = clamped;
  }, []);
  // Where the render loop pushes the playhead each frame. A ref, not state:
  // at 30 fps a state update would re-render the whole panel — and with it
  // every combo's option list — thirty times a second.
  const animTick = useRef(null);
  const [showTex, setShowTex] = useState(true);
  const [showWireframe, setShowWireframe] = useState(false);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [showAlpha, setShowAlpha] = useState(true);
  const [showUnlit, setShowUnlit] = useState(false);
  const [zoneBrightness, setZoneBrightness] = useState(0); // 0 = zone default, 1 = unlit
  const [showCollision, setShowCollision] = useState(false);
  const [showEffects, setShowEffects] = useState(true);
  // Camera readouts for the toolbar. Fly speed is mirrored from the camera each
  // frame; FOV is owned here and pushed down, since nothing else writes it.
  const [flySpeed, setFlySpeed] = useState(0);
  const [fov, setFovState] = useState(() => {
    const saved = Number(localStorage.getItem('fovDegrees'));
    return Number.isFinite(saved) && saved >= 20 && saved <= 120 ? saved : 45;
  });
  const [showNavmesh, setShowNavmesh] = useState(false);
  const [showSkybox, setShowSkyboxState] = useState(() => localStorage.getItem('skybox') === '1');
  // Persisted skybox preference — kept across zone switches and sessions.
  const setSkybox = useCallback((on) => {
    const next = !!on;
    setShowSkyboxState(next);
    try { localStorage.setItem('skybox', next ? '1' : '0'); } catch { /* quota */ }
    if (rendererRef.current) rendererRef.current.showSkybox = next;
  }, []);
  const [hasCollision, setHasCollision] = useState(false);
  const [hasNavmesh, setHasNavmesh] = useState(false);
  const [hasSkybox, setHasSkybox] = useState(false);
  const [selectedDat, setSelectedDat] = useState('');
  const [revealTarget, setRevealTarget] = useState('');
  const [objectGroups, setObjectGroups] = useState(null);   // zone object panel data
  const zoneEnvsRef = useRef(null);                         // parsed 0x2F environments (per zone)
  const zoneEnvManagerRef = useRef(null);                   // EnvironmentManager (clock + weather fades)
  const globalEffectsRef = useRef(null);                    // ROM/0/0.DAT shared effects tree
  const weatherAudioRef = useRef(null);                     // ambient weather bed (0x3D sound pointers)
  const zoneMusicRef = useRef(null);                        // zone_music.json (server zone_settings)
  const zoneMusicIdRef = useRef(null);                      // zone id of the loaded zone
  const [zoneTrack, setZoneTrackState] = useState(null);    // resolved BGM for this zone + time
  const zoneTrackRef = useRef(null);
  const setZoneTrack = useCallback((t) => { zoneTrackRef.current = t; setZoneTrackState(t); }, []);
  const [weatherList, setWeatherList] = useState([]);       // weather ids present in the zone
  const [weather, setWeather] = useState('');
  const [timeMinutes, setTimeMinutes] = useState(12 * 60);
  const [plcSelected, setPlcSelected] = useState('');       // 'mesh:…' | 'inst:…'
  const [plcOpen, setPlcOpen] = useState(true);
  const [loading, setLoading] = useState(null); // { title, detail } | null

  const player = useAudioPlayer();
  // useAudioPlayer returns a fresh object literal every render, so it must never
  // appear in a dependency array — doing so gives every dependent callback a new
  // identity each render and the effects that depend on them loop forever.
  const playerRef = useRef(player);
  playerRef.current = player;

  const beginLoad = useCallback((title, detail = '') => {
    setLoading({ title, detail });
    setStatusText(detail ? `${title} — ${detail}` : title);
  }, []);
  const stepLoad = useCallback((detail) => {
    setLoading((prev) => (prev ? { ...prev, detail } : prev));
    if (detail) setStatusText(detail);
  }, []);
  const endLoad = useCallback(() => setLoading(null), []);

  settingsRef.current = settings;

  // --- renderer lifecycle --------------------------------------------------

  useEffect(() => {
    const renderer = new Renderer(canvasRef.current);
    renderer.screenOffsetX = explorerOpen ? 180 : 0;
    rendererRef.current = renderer;
    renderer.setFogOverride({ enabled: fogOn, scale: fogScale });
    renderer.camera.fovDegrees = fov;
    renderer.playbackSpeed = playbackSpeedRef.current;
    // Restore View > Toggle WASD from last session.
    if (wasdRef.current) renderer.camera.setMode('fly');
    // Seed the toolbar readout so it never shows 0 before the first frame.
    setFlySpeed(Math.round(renderer.camera.flySpeed));

    let raf;
    let last = performance.now();
    let shownFlySpeed = -1;
    const frame = (now) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      if (wasdRef.current) renderer.camera.flyUpdate(dt, heldKeys.current);
      renderer.render(dt);
      // The camera owns fly speed and changes it from the wheel, from zone vs
      // entity range presets and from localStorage, so mirror it here rather
      // than trying to catch every writer. Only on a change of the rounded
      // value, so this is a handful of updates, not one per frame.
      const speed = Math.round(renderer.camera.flySpeed);
      if (speed !== shownFlySpeed) { shownFlySpeed = speed; setFlySpeed(speed); }
      animTick.current?.(renderer.animFrame, renderer.currentAnimation?.lengthInFrames ?? 0);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const canvas = canvasRef.current;
    const onWheel = (e) => {
      e.preventDefault();
      if (wasdRef.current) {
        // Speed still shows live in the camera-settings readout; no status-bar spam.
        renderer.camera.adjustFlySpeed(e.deltaY < 0 ? 1 : -1);
      } else {
        renderer.camera.zoom(-Math.sign(e.deltaY) * 120);
      }
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });

    const isTyping = (t) => {
      const tag = t?.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable;
    };
    const onKeyDown = (e) => {
      if (isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === 'w' || k === 'a' || k === 's' || k === 'd' || k === 'q' || k === 'e') {
        if (wasdRef.current) {
          heldKeys.current.add(k);
          e.preventDefault();
        }
      } else if (e.key === 'Shift') {
        heldKeys.current.add('shift');
      }
    };
    const onKeyUp = (e) => {
      const k = e.key.toLowerCase();
      heldKeys.current.delete(k);
      if (e.key === 'Shift') heldKeys.current.delete('shift');
    };
    const onBlur = () => heldKeys.current.clear();
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);

    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  useEffect(() => {
    if (rendererRef.current) rendererRef.current.showTextures = showTex;
  }, [showTex]);

  useEffect(() => {
    if (rendererRef.current) rendererRef.current.showWireframe = showWireframe;
  }, [showWireframe]);

  useEffect(() => {
    if (rendererRef.current) rendererRef.current.showSkeleton = showSkeleton;
  }, [showSkeleton]);

  useEffect(() => {
    if (rendererRef.current) rendererRef.current.showAlpha = showAlpha;
  }, [showAlpha]);

  useEffect(() => {
    if (rendererRef.current) rendererRef.current.unlit = showUnlit;
  }, [showUnlit]);

  useEffect(() => {
    if (rendererRef.current) rendererRef.current.lightBrightness = zoneBrightness;
  }, [zoneBrightness]);

  useEffect(() => {
    try { localStorage.setItem('explorer', explorerOpen ? '1' : '0'); } catch { /* quota */ }
    if (rendererRef.current) rendererRef.current.screenOffsetX = explorerOpen ? 180 : 0;
  }, [explorerOpen]);

  useEffect(() => {
    if (settings && rendererRef.current) rendererRef.current.setClearColor(settings.bgColor);
  }, [settings]);

  // --- model loading -------------------------------------------------------

  /**
   * Loads one or more DATs (later ones rig onto the first's skeleton) as one model.
   * opts:
   *   focusPaths  — DATs whose clips/schedules populate the viewbar lists (the
   *                 selected action set); everything still merges for playback.
   *   weaponSlots — { main: [paths], sub: [paths] } for hand re-parenting.
   *   battleTable — race's battle-idle DATs indexed by weaponAnimationType; the
   *                 equipped weapon's own battle stance is loaded as the base pose.
   *   keepCamera  — don't re-fit the camera (gear swap on the same actor).
   */
  const loadModel = useCallback(async (paths, displayName, opts = {}) => {
    const { focusPaths = null, weaponSlots = null, battleTable = null, parts = null, keepCamera = false, displayPath = null } = opts;
    // Gear swaps (keepCamera) are snappy — skip the full-screen overlay there.
    const showOverlay = !keepCamera;
    const gen = ++loadGenRef.current;
    const stillCurrent = () => gen === loadGenRef.current;
    const releaseOverlay = () => {
      if (showOverlay && overlayGenRef.current === gen) endLoad();
    };
    try {
      if (showOverlay) {
        beginLoad(displayName, 'Reading DAT…');
        overlayGenRef.current = gen;
      } else {
        setStatusText(`Loading ${displayName}…`);
      }
      const parsed = [];
      const skipped = [];
      const parse1 = async (path) => {
        const buffer = await backend.readFile(path);
        return { path, model: parseEntity(buffer, path) };
      };
      for (let i = 0; i < paths.length; i++) {
        if (!stillCurrent()) { releaseOverlay(); return; }
        const path = paths[i];
        try {
          if (showOverlay && paths.length > 1) stepLoad(`Reading DAT ${i + 1}/${paths.length}…`);
          parsed.push(await parse1(path));
        } catch (err) {
          // Character/NPC merges list DATs that may not exist in every client
          // build — drop those instead of failing the whole actor.
          if (paths.length === 1) throw err;
          skipped.push(path);
          console.warn(`skipping ${path}:`, err);
        }
      }
      if (!stillCurrent()) { releaseOverlay(); return; }
      if (parsed.length === 0) throw new Error('no readable DATs');
      if (showOverlay) stepLoad('Building model…');

      // The right battle idle depends on the equipped weapon's animation type,
      // only known after parsing it — resolve + merge that battle DAT now so the
      // weapon rests in its own stance (e.g. a greatsword held two-handed), not
      // the hand-to-hand fists idle. Non-focus, so it never enters the lists.
      if (battleTable && weaponSlots?.main?.length) {
        const mainSet = new Set(weaponSlots.main.map((p) => p.toLowerCase()));
        const weapon = parsed.find((e) => mainSet.has(e.path.toLowerCase()))?.model;
        const type = weapon?.info?.weaponAnimationType;
        const rel = type != null ? battleTable[type] : null;
        if (rel) {
          const abs = `${settingsRef.current.gamePath}\\${rel.replace(/\//g, '\\')}`;
          if (!parsed.some((e) => e.path.toLowerCase() === abs.toLowerCase())) {
            try { parsed.push(await parse1(abs)); } catch (err) { console.warn(`battle idle ${abs}:`, err); }
          }
        }
      }
      if (!stillCurrent()) { releaseOverlay(); return; }
      const model = parsed.length === 1 ? parsed[0].model : mergeModels(parsed.map((e) => e.model), displayName);

      if (!model.isRenderable) {
        releaseOverlay();
        setStatusText(`${displayName} — no renderable skeleton+mesh (skeleton: ${model.skeleton ? 'yes' : 'no'}, mesh groups: ${model.meshGroups.length})`);
        return;
      }

      if (showOverlay) stepLoad('Uploading to GPU…');
      // Drawn-weapon attach (xim jointParentOverrides): re-parent the weapon
      // grip joint (info.standardJointIndex -> joint reference) onto the hand
      // attach reference — 127 right hand (main), 126 left hand (sub).
      const refs = model.skeleton?.references ?? [];
      if (weaponSlots && refs.length > 127) {
        const overrides = new Map();
        for (const [slot, handRefIdx] of [['main', 127], ['sub', 126]]) {
          const slotSet = new Set((weaponSlots[slot] ?? []).map((p) => p.toLowerCase()));
          const weapon = parsed.find((e) => slotSet.has(e.path.toLowerCase()))?.model;
          const stdIdx = weapon?.info?.standardJointIndex;
          if (stdIdx == null) continue;
          const grip = refs[stdIdx];
          const hand = refs[handRefIdx];
          if (grip && hand && grip.index !== hand.index) overrides.set(grip.index, hand.index);
        }
        if (overrides.size) model.jointOverrides = overrides;
      }

      // Loading a model takes over the viewport — stop any music and close the player.
      player.stop();

      if (!stillCurrent()) { releaseOverlay(); return; }
      const renderer = rendererRef.current;
      // Gear swap: remember progress so the same clip continues mid-cycle.
      const resumeFrame = keepCamera ? renderer.animFrame : null;
      const wasPlaying = renderer.playing;
      const prevPlay = appliedPlayRef.current;
      modelRef.current = model;
      renderer.setModel(model, keepCamera);
      const primaryPath = displayPath ?? paths[paths.length - 1];
      setSelectedDat(primaryPath.toLowerCase());
      setModelPath(relativeName(primaryPath));
      shownPathRef.current = primaryPath;
      sourcePathRef.current = paths[paths.length - 1];

      // Viewbar lists. Group over the WHOLE model so each clip's body-region
      // parts merge across DATs — locomotion is split (lower body wlk0 lives in
      // the race/movement DAT, upper body wlk1 in the weapon's battle DAT), and
      // grouping only the focus DATs would drop the lower half. Then, with a
      // focus set (the selected action's schedule DATs), keep just the groups
      // those DATs contribute — motion packs still merge for playback but never
      // flood the list (Motion.csv rows are whole-class aggregated ranges).
      let grouped = groupAnimations(model.animations)
        .filter((g) => g.clip.jointTracks.size > 0 && g.clip.numFrames > 0);
      let schedSrc = model.schedules ?? [];
      if (focusPaths?.length) {
        const fset = new Set(focusPaths.map((p) => p.toLowerCase()));
        const fBases = new Set();   // clip display-names (body-slot digit stripped)
        const fScheds = new Set();
        for (const { path, model: m } of parsed) {
          if (!fset.has(path.toLowerCase())) continue;
          for (const a of m.animations) fBases.add(animDisplayName(a.id));
          for (const s of m.schedules ?? []) fScheds.add(s.id);
        }
        // Unconditional: if the action's own DATs are missing from this client
        // build, the lists stay empty rather than falling back to every clip.
        schedSrc = schedSrc.filter((s) => fScheds.has(s.id));
        for (const s of schedSrc) for (const c of s.clipIds) fBases.add(animDisplayName(c));
        grouped = grouped.filter((g) => fBases.has(g.id));
      }
      animsRef.current = grouped;
      setAnims(grouped);
      setSchedules(schedSrc);
      // What to play, best first: the user's remembered pick if this actor still
      // has it, then idle, then (for a focused action set, which has no idle)
      // its 'main' schedule so picking a weapon skill shows the skill.
      const want = animSelRef.current ?? {};
      const pickSched = (id) => schedSrc.find((s) => s.id === id && s.clipIds.length);
      const chosen =
        (want.schedule && pickSched(want.schedule) && { schedule: pickSched(want.schedule) })
        || (want.anim && grouped.find((g) => g.id === want.anim) && { anim: grouped.find((g) => g.id === want.anim) })
        || (grouped.find((g) => g.id.toLowerCase().startsWith('idl')) && { anim: grouped.find((g) => g.id.toLowerCase().startsWith('idl')) })
        || (focusPaths?.length && (pickSched('main') ?? schedSrc.find((s) => s.clipIds.length))
          && { schedule: pickSched('main') ?? schedSrc.find((s) => s.clipIds.length) })
        || null;

      const autoPlay = settingsRef.current?.autoPlay ?? true;
      if (chosen?.anim) {
        const same = keepCamera && prevPlay.kind === 'anim' && prevPlay.id === chosen.anim.id;
        renderer.setAnimation(chosen.anim.clip, same ? { frame: resumeFrame } : undefined);
        renderer.playing = same ? wasPlaying : !!autoPlay;
        appliedPlayRef.current = { kind: 'anim', id: chosen.anim.id };
        setCurrentAnim(chosen.anim.id);
        setCurrentSchedule('');
        setPlayingState(renderer.playing);
      } else if (chosen?.schedule) {
        const same = keepCamera && prevPlay.kind === 'schedule' && prevPlay.id === chosen.schedule.id;
        renderer.setAnimation(scheduleClip(model, chosen.schedule), same ? { frame: resumeFrame } : undefined);
        renderer.playing = same ? wasPlaying : !!autoPlay;
        appliedPlayRef.current = { kind: 'schedule', id: chosen.schedule.id };
        setCurrentSchedule(chosen.schedule.id);
        setCurrentAnim('');
        setPlayingState(renderer.playing);
      } else {
        renderer.setAnimation(null);
        renderer.playing = false;
        appliedPlayRef.current = { kind: null, id: '' };
        setCurrentAnim('');
        setCurrentSchedule('');
        setPlayingState(false);
      }
      // Re-fit after the idle pose is applied so the floor snaps to feet (not bind-pose /
      // dangling weapon tips that made some actors hover). Gear swaps on the
      // same actor keep the user's camera.
      if (keepCamera) renderer.snapFloorToFeet();
      else renderer.fitCamera();

      const statsOf = (models) => ({
        joints: models.find((m) => m.skeleton)?.skeleton.joints.length ?? null,
        verts: models.reduce((s, m) => s + m.meshGroups.reduce((a, g) => a + g.vertices.length, 0), 0),
        tris: models.reduce((s, m) => s + m.meshGroups.reduce(
          (a, g) => a + g.pieces.reduce((t, p) => t + (p.topology === 'strip' ? p.corners.length - 2 : p.corners.length / 3), 0), 0), 0),
        animCount: models.reduce((s, m) => s + m.animations.length, 0),
        scheduleCount: models.reduce((s, m) => s + (m.schedules?.length ?? 0), 0),
        textures: models.flatMap((m) => [...m.textures.values()]).map((t) => ({
          name: t.name, width: t.width, height: t.height, format: t.format, data: t.data,
        })),
      });

      // Per-part breakdown (character composer): stats of each slot's own DATs.
      const infoParts = (parts ?? [])
        .map((p) => {
          const set = new Set(p.paths.map((x) => x.toLowerCase()));
          const models = parsed.filter((e) => set.has(e.path.toLowerCase())).map((e) => e.model);
          return models.length
            ? { key: p.key, label: p.label, itemLabel: p.itemLabel, relPaths: p.paths.map(relativeName), ...statsOf(models) }
            : null;
        })
        .filter(Boolean);

      setModelInfo({
        name: displayName,
        ...statsOf([model]),
        joints: model.skeleton.joints.length,
        parts: infoParts,
      });

      setTexWindows([]);   // close texture windows from the previous model
      setObjectGroups(null);
      setPlcSelected('');
      setHasCollision(false);
      setHasNavmesh(false);
      setHasSkybox(false);
      setShowCollision(false);
      setShowNavmesh(false);
      setShowSkyboxState(false);   // entities have no sky; keep the saved preference
      if (rendererRef.current) {
        rendererRef.current.showCollision = false;
        rendererRef.current.showNavmesh = false;
        rendererRef.current.showSkybox = false;
        rendererRef.current.setNavmesh(null);
        rendererRef.current.setSkyDome(null);
      }
      zoneEnvsRef.current = null;
      setWeatherList([]);
      releaseOverlay();
      setStatusText(skipped.length ? `${skipped.length} missing DAT${skipped.length > 1 ? 's' : ''} skipped` : '');
      try {
        localStorage.setItem(LAST_DAT_KEY, JSON.stringify({ paths, name: displayName, opts: { focusPaths, weaponSlots, battleTable, parts } }));
      } catch { /* quota / private mode */ }
    } catch (err) {
      console.error(err);
      releaseOverlay();
      if (stillCurrent()) setStatusText(`${displayName} — failed to load: ${err.message ?? err}`);
    }
  }, [beginLoad, stepLoad, endLoad]);

  const relativeName = (path) => {
    const base = settingsRef.current?.gamePath ?? '';
    return base && path.toLowerCase().startsWith(base.toLowerCase())
      ? path.slice(base.length).replace(/^[\\/]+/, '')
      : path;
  };

  const loadFromTree = useCallback(
    (path) => loadModel([path], relativeName(path)),
    [loadModel]);

  const loadNpcEntry = useCallback(
    (entry) => {
      const abs = (p) => `${settingsRef.current.gamePath}\\${p}`;
      loadModel(entry.paths.map(abs), entry.name, {
        focusPaths: entry.focusPaths?.map(abs) ?? null,
        weaponSlots: entry.weaponSlots
          ? Object.fromEntries(Object.entries(entry.weaponSlots).map(([k, v]) => [k, (v ?? []).map(abs)]))
          : null,
        battleTable: entry.battleTable ?? null,
        parts: entry.parts?.map((p) => ({ ...p, paths: p.paths.map(abs) })) ?? null,
        keepCamera: !!entry.keepCamera,
        displayPath: entry.displayPath ? abs(entry.displayPath) : null,
      });
    },
    [loadModel]);

  // Cached FFXiMain.dll decrypt tables (zone 0x2E / 0x1C).
  const keyTablesRef = useRef(null);
  const getKeyTables = useCallback(async () => {
    if (keyTablesRef.current) return keyTablesRef.current;
    const gamePath = settingsRef.current?.gamePath;
    if (!gamePath) throw new Error('Game path not set');
    const dllPath = `${gamePath}\\FFXiMain.dll`;
    const buf = await backend.readFile(dllPath);
    keyTablesRef.current = extractKeyTables(buf);
    return keyTablesRef.current;
  }, []);

  /**
   * Build the zone's particle system (xim ParticleSystem + GlobalDirectory).
   *
   * ROM/0/0.DAT is the shared `syst/effe` tree every zone links into for common
   * meshes, sprites and curves — impact splashes, sparks, lens flares. It's
   * loaded once and cached, since zones swap far more often than it changes.
   */
  const buildParticleSystem = useCallback(async (treeBuf, parsed, environment, gamePath) => {
    const warnings = [];
    const effectParser = {
      [SEC.EFFECT]: (b, d, s, e) => parseParticleGenerator(b, d, s, e, (m) => warnings.push(m)),
    };
    const zoneParsers = makeParsers(effectParser, true);
    const globalParsers = makeParsers(effectParser, false);

    const treeOf = (buffer, parsers) => {
      const bytes = new Uint8Array(buffer);
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return buildDatTree(bytes, dv, parseSections(dv), parsers, (m) => warnings.push(m));
    };

    if (!globalEffectsRef.current) {
      try {
        const buf = await backend.readFile(`${gamePath}\\ROM\\0\\0.DAT`);
        globalEffectsRef.current = { root: treeOf(buf, globalParsers), textures: parseDatTextures(buf) };
      } catch (e) {
        console.warn('shared effects DAT (ROM/0/0.DAT) unavailable', e);
        globalEffectsRef.current = { root: null, textures: new Map() };
      }
    }

    const system = new ParticleSystem({
      zoneRoot: treeOf(treeBuf, zoneParsers),
      globalRoot: globalEffectsRef.current.root,
      zoneMeshIdToName: parsed.meshIdToName,
      zoneMeshes: parsed.meshes,
      zoneMeshSections: parsed.meshSections,
      camera: null,                 // supplied by renderer.setParticleSystem
      environment,
      onWarn: (m) => console.debug('[particles]', m),
    });

    const zoneCount = system.registerZoneEffects();
    if (warnings.length) console.debug(`[particles] ${warnings.length} parse warnings`);
    console.debug(`[particles] registered ${zoneCount} zone effects`);
    return system;
  }, []);

  /**
   * Zone BGM from the server's zone_settings (see dev/bake-zone-music.mjs).
   * Each zone names a day and a night track; id 0 means genuine silence, which
   * is why Valkurm Dunes and Qufim Island have no daytime music.
   *
   * Resolving is cheap and happens on zone load / time change; *decoding* is not
   * (ATRAC3 shells out to vgmstream), so playback is left to an explicit press
   * of the play button rather than firing automatically on every zone load.
   */
  const resolveZoneTrack = useCallback(async (zoneId, isNight) => {
    if (zoneId == null) { setZoneTrack(null); return; }
    if (!zoneMusicRef.current) {
      try {
        const res = await fetch('lists/zone_music.json');
        zoneMusicRef.current = res.ok ? await res.json() : {};
      } catch { zoneMusicRef.current = {}; }
    }
    const entry = zoneMusicRef.current[String(zoneId)];
    const track = isNight ? (entry?.night ?? entry?.day) : (entry?.day ?? entry?.night);
    setZoneTrack(track?.root ? { ...track, isNight } : null);
  }, []);

  /** Play (or stop) the resolved zone track. */
  const toggleZoneMusic = useCallback(async () => {
    const p = playerRef.current;
    const track = zoneTrackRef.current;
    if (!p) return;
    if (!track) { p.stop(); return; }

    const path = `${settingsRef.current?.gamePath}\\${track.root}\\win\\music\\data\\${track.file}`;
    if (p.current?.path === path && p.playing) { p.pause(); return; }
    if (p.current?.path === path) { p.resume(); return; }

    try {
      await p.play({
        file: track.file,
        path,
        root: track.root,
        num: String(track.id),
        name: track.name ?? `music${String(track.id).padStart(3, '0')}`,
      });
    } catch (e) {
      console.warn('zone music failed', e);
      setStatusText(`Zone music failed: ${e.message ?? e}`);
    }
  }, []);

  /**
   * Ambient weather audio. The context is created lazily on first use because
   * browsers refuse to start one before a user gesture.
   */
  const getWeatherAudio = useCallback(() => {
    if (weatherAudioRef.current) return weatherAudioRef.current;
    let ctx = null;
    weatherAudioRef.current = new WeatherAudio({
      getContext: () => {
        if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === 'suspended') ctx.resume();
        return ctx;
      },
      loadSound: async (relPath) => {
        const gamePath = settingsRef.current?.gamePath;
        if (!gamePath) return null;
        const abs = `${gamePath}\\${relPath}`;
        const buffer = await backend.readFile(abs);
        const header = parseAudioHeader(buffer);
        const audioCtx = weatherAudioRef.current.getContext();
        // The loop point is a property of the source file, so it survives
        // whichever decoder runs. Without it an ambient bed replays its intro
        // on every cycle and clicks.
        const loopStart = header?.loopStartSec ?? 0;
        // ATRAC3 needs the native decoder via vgmstream; ADPCM/PCM decode here.
        if (header?.sampleFormat === FMT_ATRAC3) {
          const wav = await backend.decodeVgmstream(abs);
          return { buffer: await audioCtx.decodeAudioData(wav), loopStart };
        }
        return { buffer: toAudioBuffer(audioCtx, buffer).audioBuffer, loopStart };
      },
    });
    return weatherAudioRef.current;
  }, []);

  /** Load a zone DAT into the viewport (Assets > Zones). */
  const loadZone = useCallback(async (zone) => {
    const gamePath = settingsRef.current?.gamePath;
    if (!gamePath) {
      setStatusText('Game path not set — open Settings first.');
      return;
    }
    const rel = zoneDatRelPath(zone.path);
    const abs = `${gamePath}\\${rel}`;
    const displayName = zone.name || rel;
    const gen = ++loadGenRef.current;
    const stillCurrent = () => gen === loadGenRef.current;
    const releaseOverlay = () => {
      if (overlayGenRef.current === gen) endLoad();
    };
    try {
      beginLoad(displayName, 'Reading DAT…');
      overlayGenRef.current = gen;
      player.stop();
      const [datBuf, keyTables] = await Promise.all([
        backend.readFile(abs),
        getKeyTables(),
      ]);
      if (!stillCurrent()) { releaseOverlay(); return; }
      stepLoad('Decrypting zone…');
      // Yield so the overlay can paint before the heavy CPU work.
      await yieldToPaint();
      if (!stillCurrent()) { releaseOverlay(); return; }
      // parseZone decrypts the 0x2E/0x1C chunks in place, so the DAT tree needs
      // its own copy of the bytes taken before that happens.
      const treeBuf = datBuf.slice(0);
      const parsed = parseZone(datBuf, keyTables);

      // Xim terrain lighting + procedural sky dome from the 0x2F environment.
      // EnvironmentManager owns the clock and the weather cross-fade; the panel
      // drives it rather than re-resolving the DAT on every change.
      let environment = null;
      let terrainLit = null;
      let skyDome = null;
      let envs = null;
      let weather0 = null;
      const time0 = 12 * 60;
      try {
        const byRoot = parseEnvironmentsByRoot(treeBuf);
        envs = byRoot.get('weat') ?? new Map();
        environment = new EnvironmentManager(byRoot);
        environment.setTimeMinutes(time0);
        weather0 = environment.getWeather();
        terrainLit = environment.getTerrainLighting();
        skyDome = environment.getSkyDome();
      } catch (e) { console.warn('environment parse failed', e); }
      zoneEnvsRef.current = envs;

      // Live particle system: zone effects (water, spray, fountains) plus the
      // active weather's effects, driven by the ported xim runtime.
      stepLoad('Loading effects…');
      let particleSystem = null;
      try {
        particleSystem = await buildParticleSystem(treeBuf, parsed, environment, gamePath);
        if (environment) environment.particleSystem = particleSystem;
        // The weather set is activated after the renderer attaches its camera —
        // sun/moon generators read the camera as they're constructed.
      } catch (e) { console.warn('particle system init failed', e); }
      if (!stillCurrent()) { releaseOverlay(); return; }
      stepLoad('Baking placements…');
      await yieldToPaint();
      if (!stillCurrent()) { releaseOverlay(); return; }
      const model = zoneToModel(parsed, displayName);
      if (!model.isRenderable) {
        releaseOverlay();
        setStatusText(`${displayName} — no renderable mesh`);
        return;
      }

      stepLoad('Uploading to GPU…');
      if (!stillCurrent()) { releaseOverlay(); return; }
      // Shared-effect textures live in ROM/0/0.DAT, not the zone; fold them in
      // so particles linking to them have something to sample.
      for (const [name, tex] of globalEffectsRef.current?.textures ?? []) {
        if (!model.textures.has(name)) model.textures.set(name, tex);
      }
      modelRef.current = model;
      const renderer = rendererRef.current;
      renderer.setFloorTexture(null);   // actor floor plane doesn't apply to zones
      setSelectedFloor('');
      // Always push lighting (fallback when the DAT has no 0x2F / indoor default).
      renderer.setTerrainLighting(terrainLit || terrainLightingFromEnv(null, time0));
      renderer.setSkyDome(skyDome);
      renderer.skyWeather = weather0;
      renderer.setModel(model);
      // setModel clears any previous system, so attach after it. Attaching also
      // installs the camera adapter, which the weather generators need.
      renderer.setParticleSystem(particleSystem, environment);
      environment?.activateInitialWeather();
      zoneEnvManagerRef.current = environment;
      if (particleSystem && environment) {
        const audio = getWeatherAudio();
        audio.attach(particleSystem, environment);
        audio.setEnabled(localStorage.getItem('weatherAudio') !== '0');
        audio.setVolume(sfxVolumeRef.current);
        renderer.weatherAudio = audio;
      }

      // Zone BGM. FFXI treats 18:00–06:00 as night for music purposes.
      zoneMusicIdRef.current = zone.id ?? null;
      const hour = Math.floor((environment?.getTimeMinutes() ?? time0) / 60);
      resolveZoneTrack(zone.id, hour < 6 || hour >= 18);
      setSelectedDat(abs.toLowerCase());
      setModelPath(rel);
      shownPathRef.current = abs;
      sourcePathRef.current = abs;
      animsRef.current = [];
      setAnims([]);
      setSchedules([]);
      setCurrentAnim('');
      setCurrentSchedule('');
      setPlayingState(false);
      renderer.setAnimation(null);
      renderer.playing = false;
      // Auto-WASD for zones (setting default on) — set mode before fit so the
      // fly camera seats on the fitted orbit eye.
      if (settingsRef.current?.autoWasdZones !== false) setWasd(true);
      renderer.fitCamera();

      const zs = model.zoneStats ?? {};
      // Skybox = gradient dome and/or cloud shells. Indoor star/sun discs alone
      // don't count — those zones get the "No Skybox" weather notice.
      const hasClouds = (model.zoneDraws ?? []).some(
        (d) => d.layer === 'sky' && !d.celestial && !d.positioned,
      );
      const hasSky = !!skyDome || hasClouds;
      setHasCollision(!!model.collision?.positions?.length);
      setHasSkybox(hasSky);
      setWeatherList(envs ? listWeathers(envs) : []);
      setWeather(weather0 || '');
      setTimeMinutes(time0);
      setShowCollision(false);
      setShowNavmesh(false);
      renderer.showCollision = false;
      renderer.showNavmesh = false;
      // Restore the saved skybox preference (off if this zone has no sky).
      setSkybox(hasSky && localStorage.getItem('skybox') === '1');
      // Navmesh from public/navmesh/<ZoneName>.nav (async; doesn't block load).
      setHasNavmesh(false);
      loadZoneNavmesh(displayName).then((nav) => {
        if (modelRef.current !== model) return; // zone changed
        if (nav) {
          renderer.setNavmesh(nav);
          setHasNavmesh(true);
        } else {
          renderer.setNavmesh(null);
          setHasNavmesh(false);
        }
      }).catch(() => { setHasNavmesh(false); });
      setObjectGroups(model.objectGroups ?? []);
      setPlcSelected('');
      setPlcOpen(true);
      setModelInfo({
        name: displayName,
        joints: 1,
        verts: zs.vertexCount ?? 0,
        tris: zs.triCount ?? 0,
        animCount: 0,
        scheduleCount: 0,
        textures: [...model.textures.values()].map((t) => ({
          name: t.name, width: t.width, height: t.height, format: t.format, data: t.data,
        })),
        parts: [],
        zone: {
          id: zone.id,
          path: rel,
          meshCount: zs.meshCount,
          placementCount: zs.placementCount,
          placementTotal: zs.placementTotal,
          objectTypes: zs.objectTypes,
          skippedWild: zs.skippedWild ?? 0,
          skippedMissing: zs.skippedMissing ?? 0,
          envCount: zs.envCount ?? 0,
          collTris: zs.collTris ?? 0,
        },
      });
      setTexWindows([]);
      releaseOverlay();
      setStatusText('');   // zone stats live in Details
      try {
        localStorage.setItem(LAST_DAT_KEY, JSON.stringify({
          kind: 'zone',
          zone: { id: zone.id, name: zone.name, path: zone.path },
        }));
      } catch { /* quota */ }
    } catch (err) {
      console.error(err);
      releaseOverlay();
      if (stillCurrent()) setStatusText(`${displayName} — failed: ${err.message ?? err}`);
    }
  }, [getKeyTables, beginLoad, stepLoad, endLoad, setWasd, buildParticleSystem, getWeatherAudio, resolveZoneTrack]);

  // Character composer (Assets > Characters) — shared by the left panel and
  // the Animation panel Action combo.
  const pc = useCharacter({
    enabled: leftView === 'pc' && !!settings?.gamePath,
    onLoad: loadNpcEntry,
    onError: (msg) => setStatusText(msg),
  });

  // --- startup -------------------------------------------------------------

  useEffect(() => {
    (async () => {
      try {
        const saved = localStorage.getItem('gamePath');
        const gamePath = (saved || (await backend.defaultGamePath())).trim();
        const initialSettings = loadSettings(gamePath);
        setSettings(initialSettings);
        // Mirror to the ref now: setSettings won't reach it until the next
        // render, but loadImage() below reads settingsRef.current this tick.
        settingsRef.current = initialSettings;

        if (!gamePath) {
          setSettingsError('Game path not set. Browse to your FINAL FANTASY XI install folder.');
          setSettingsOpen(true);
          setStatusText('Set a game path in Settings to get started.');
          return;
        }

        try {
          await backend.listDir(gamePath);
        } catch {
          setSettingsError(`Game path not found:\n${gamePath}`);
          setSettingsOpen(true);
          setStatusText('Game path not found — open Settings to fix it.');
          return;
        }

        // Flat views (Images/Music/SFX) own no 3D model, so reopening on one
        // must NOT resurrect the last character behind it. Restore what that
        // page was showing instead and skip the model load entirely.
        const restoredView = localStorage.getItem(LAST_VIEW_KEY);
        if (restoredView === 'images') {
          try {
            const img = JSON.parse(localStorage.getItem(LAST_IMAGE_KEY) || 'null');
            if (img?.path) await loadImage(img);
          } catch { /* stale/corrupt entry — just show the list */ }
          return;
        }
        if (restoredView === 'music' || restoredView === 'sfx') return;   // lists only

        // Prefer the last successfully loaded DAT; fall back to the default demo model.
        let paths = null;
        let name = null;
        let lastOpts = null;
        let lastZone = null;
        try {
          const last = JSON.parse(localStorage.getItem(LAST_DAT_KEY) || 'null');
          if (last?.kind === 'zone' && last.zone?.path) {
            lastZone = last.zone;
          } else if (last?.paths?.length) {
            await backend.readFile(last.paths[0]);   // probe — throws if missing
            paths = last.paths;
            name = last.name || relativeName(last.paths[last.paths.length - 1]);
            lastOpts = last.opts ?? null;
          }
        } catch { /* stale path or corrupt entry */ }

        if (lastZone) {
          setLeftView('zones');
          await loadZone(lastZone);
          return;
        }

        if (!paths) {
          paths = [`${gamePath}\\${DEFAULT_DAT_SUFFIX}`];
          name = DEFAULT_DAT_SUFFIX;
        }
        await loadModel(paths, name, lastOpts ?? {});
        setRevealTarget(paths[paths.length - 1].toLowerCase());
      } catch (err) {
        console.error(err);
        setStatusText(`Startup failed: ${err.message ?? err}`);
      }
    })();
  }, [loadModel, loadZone]);

  // Debug/verification hook (used by the headless capture flow)
  useEffect(() => {
    window.cexi = {
      renderer: rendererRef.current,
      loadDat: (p) => loadModel([p], p),
      loadZone,
      getModel: () => modelRef.current,
    };
  }, [loadModel, loadZone]);

  // --- texture windows -----------------------------------------------------

  const openTexture = useCallback((tex) => {
    setTexWindows((prev) => {
      const i = prev.findIndex((w) => w.tex.name === tex.name);
      if (i >= 0) {
        // Already open — bring to front (keep cascade so it doesn't jump)
        const next = prev.slice();
        const [w] = next.splice(i, 1);
        next.push(w);
        return next;
      }
      const id = ++texIdRef.current;
      return [...prev, { id, tex, cascade: id - 1 }];
    });
  }, []);

  const closeTexture = useCallback((id) => {
    setTexWindows((prev) => prev.filter((w) => w.id !== id));
  }, []);

  const focusTexture = useCallback((id) => {
    setTexWindows((prev) => {
      const i = prev.findIndex((w) => w.id === id);
      if (i < 0 || i === prev.length - 1) return prev;
      const next = prev.slice();
      const [w] = next.splice(i, 1);
      next.push(w);
      return next;
    });
  }, []);

  // Escape closes the topmost modal (export → settings → help → top texture).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (exportSpec) { setExportSpec(null); e.preventDefault(); return; }
      if (settingsOpen) { setSettingsOpen(false); e.preventDefault(); return; }
      if (helpOpen) { setHelpOpen(false); e.preventDefault(); return; }
      if (texWindows.length > 0) {
        setTexWindows((prev) => prev.slice(0, -1));
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [exportSpec, settingsOpen, helpOpen, texWindows.length]);

  // --- handlers ------------------------------------------------------------

  const handleAnimChange = (id) => {
    setCurrentAnim(id);
    setCurrentSchedule('');
    rememberAnimSel({ anim: id, schedule: '' });
    appliedPlayRef.current = { kind: 'anim', id };
    const entry = animsRef.current.find((g) => g.id === id);
    rendererRef.current.setAnimation(entry ? entry.clip : null);
  };

  const handleScheduleChange = (id) => {
    setCurrentSchedule(id);
    setCurrentAnim('');
    rememberAnimSel({ anim: '', schedule: id });
    appliedPlayRef.current = { kind: 'schedule', id };
    const model = modelRef.current;
    const sched = model?.schedules.find((s) => s.id === id);
    const clip = sched?.clipIds?.length ? scheduleClip(model, sched) : null;
    rendererRef.current.setAnimation(clip);
    if (clip) {
      rendererRef.current.playing = true;
      setPlayingState(true);
    } else {
      rendererRef.current.playing = false;
      setPlayingState(false);
    }
  };

  const setPlaying = (p) => {
    rendererRef.current.playing = p;
    setPlayingState(p);
  };

  const animControls = {
    anims, currentAnim, onAnimChange: handleAnimChange,
    schedules, currentSchedule, onScheduleChange: handleScheduleChange,
    playing, onTogglePlay: () => setPlaying(!playing),
    frameSink: animTick, onSeek: (f) => rendererRef.current?.seekTo(f),
    speed: playbackSpeed, onSpeed: setPlaybackSpeed,
  };

  /** Status-bar path → show that DAT in the system file manager, selected.
   *  sourcePathRef keeps the real casing; selectedDat is lowercased for the
   *  tree's own matching and would be a poor thing to hand the OS. */
  const revealInExplorer = async () => {
    const path = shownPathRef.current;
    if (!path) return;
    try {
      await backend.revealPath(path);
    } catch (err) {
      setStatusText(`Could not show in Explorer: ${err.message ?? err}`);
    }
  };

  // Play a raw DAT clip id (e.g. "at00") by switching to its display group ("at0").
  const playClipId = (rawId) => {
    const group = animsRef.current.find((g) => g.id === rawId)
      || animsRef.current.find((g) => g.id === animDisplayName(rawId));
    if (!group) return;
    handleAnimChange(group.id);
    rendererRef.current.playing = true;
    setPlayingState(true);
  };

  // --- scene / floor -------------------------------------------------------

  const resolveSpecPath = (spec) => {
    const parts = spec.split('/');
    const [rom, dir, file] = parts.length === 2 ? ['1', parts[0], parts[1]] : parts;
    const romDir = rom === '1' ? 'ROM' : `ROM${rom}`;
    return `${settingsRef.current.gamePath}\\${romDir}\\${dir}\\${file}.DAT`;
  };

  const loadFloor = useCallback(async (spec, fourcc) => {
    try {
      const buffer = await backend.readFile(resolveSpecPath(spec));
      const tex = parseFloorTexture(buffer, fourcc);
      if (!tex) { setStatusText(`Floor '${fourcc}' not found in ${spec}`); return; }
      rendererRef.current.setFloorTexture(tex);
      setSelectedFloor(`${spec}:${fourcc}`);
    } catch (e) {
      setStatusText(`Failed to load floor: ${e.message ?? e}`);
    }
  }, []);

  const clearFloor = useCallback(() => {
    rendererRef.current.setFloorTexture(null);
    setSelectedFloor('');
  }, []);

  const setBg = useCallback((hex) => {
    rendererRef.current.setClearColor(hex);
    rendererRef.current.setFog({ color: hex });   // fade toward the background
    localStorage.setItem('bgColor', hex);
    setSettings((s) => (s ? { ...s, bgColor: hex } : s));
  }, []);

  // Fog on/off + a distance scale over whatever the scene authored. For zones
  // that's the 0x2F environment (re-pushed every frame while weather fades), so
  // these are kept as an override the renderer re-applies rather than a value
  // the environment can overwrite.
  // Off unless the user turned it on before — absent key = off.
  const [fogOn, setFogOnState] = useState(() => localStorage.getItem('fogOn') === '1');
  const [fogScale, setFogScaleState] = useState(() => {
    const v = parseFloat(localStorage.getItem('fogScale'));
    return Number.isFinite(v) && v > 0 ? v : 1;
  });

  const setFogOn = useCallback((on) => {
    setFogOnState(on);
    try { localStorage.setItem('fogOn', on ? '1' : '0'); } catch { /* quota */ }
    rendererRef.current?.setFogOverride({ enabled: on });
  }, []);

  const setFogScale = useCallback((scale) => {
    setFogScaleState(scale);
    try { localStorage.setItem('fogScale', String(scale)); } catch { /* quota */ }
    rendererRef.current?.setFogOverride({ scale });
  }, []);

  // ── Assets > Images ────────────────────────────────────────────────────────
  const [imageEntry, setImageEntry] = useState(null);   // { name, path }
  const [imageDoc, setImageDoc] = useState(null);       // parseImageDat result + resolved sets
  const [imageSet, setImageSet] = useState(null);

  /** Drop the scene and everything that described it. */
  const unloadModel = useCallback(() => {
    rendererRef.current?.setModel(null);
    modelRef.current = null;
    // Zone ambience is driven by the particle system, which setModel just threw
    // away — detach so the weather bed stops instead of holding its last voice.
    weatherAudioRef.current?.attach(null, null);
    appliedPlayRef.current = { kind: null, id: '' };
    setModelInfo(null);
    setModelPath('');
    setSelectedDat('');
    shownPathRef.current = '';
    sourcePathRef.current = '';
    setAnims([]);
    setCurrentAnim('');
    setSchedules([]);
    setCurrentSchedule('');
    setPlayingState(false);
    setObjectGroups(null);
    setStatusText('');
  }, []);

  // One view on screen at a time, each arriving clean. Without this a model
  // keeps rendering (and animating) behind the Images page, music plays on under
  // a 3D view, and the GPU carries a scene nobody can see.
  const prevViewRef = useRef(leftView);
  useEffect(() => {
    const prev = prevViewRef.current;
    if (prev === leftView) return;
    prevViewRef.current = leftView;

    // Zones <-> Scene share one zone; anything else starts empty. Characters
    // reloads itself on arrival, so unloading here just clears the old actor.
    if (!(ZONE_VIEWS.has(prev) && ZONE_VIEWS.has(leftView))) unloadModel();
    if (!(AUDIO_VIEWS.has(prev) && AUDIO_VIEWS.has(leftView))) player.stop();
    if (leftView !== 'images') { setImageEntry(null); setImageDoc(null); setImageSet(null); }
  }, [leftView, unloadModel, player]);

  const loadImage = useCallback(async (entry) => {
    const gamePath = settingsRef.current?.gamePath;
    if (!gamePath) { setStatusText('Game path not set — open Settings first.'); return; }
    setImageEntry(entry);
    // Remember it so reopening on the Images page restores this image rather
    // than falling through to the default model. Store just {name, path}.
    try { localStorage.setItem(LAST_IMAGE_KEY, JSON.stringify({ name: entry.name, path: entry.path })); } catch { /* quota */ }
    setImageSet(null);
    setImageDoc(null);
    // Images are 2D and cover the viewport, so anything still in the scene just
    // shows through. Drop it the way switching to Music does.
    rendererRef.current?.setModel(null);
    modelRef.current = null;
    setModelPath(entry.path);
    setAnims([]);
    setCurrentAnim('');
    try {
      const buf = await backend.readFile(`${gamePath}\\${entry.path}`);
      const doc = parseImageDat(buf);
      if (doc.kind === 'sets') {
        // Resolve each set's atlas once here so the panel and the viewer agree.
        doc.sets = doc.sets.map((s) => ({ ...s, texture: textureForSet(s, doc.textures) }));
      }
      setImageDoc(doc);
      const first = doc.kind === 'sets' ? doc.sets.find((s) => s.texture) ?? doc.sets[0] : null;
      setImageSet(first ?? null);
      setStatusText(doc.kind === 'png' ? 'PNG' : `${doc.sets?.length ?? 0} image sets`);
    } catch (e) {
      setImageDoc({ kind: 'empty' });
      setStatusText(`Failed to read ${entry.path}: ${e.message ?? e}`);
    }
  }, []);

  const setFov = useCallback((deg) => {
    const v = Math.min(120, Math.max(20, Math.round(deg)));
    setFovState(v);
    try { localStorage.setItem('fovDegrees', String(v)); } catch { /* quota */ }
    // Read fresh every frame by projectionMatrix(), so no redraw call needed.
    const camera = rendererRef.current?.camera;
    if (camera) camera.fovDegrees = v;
  }, []);

  // Ambient/weather SFX volume. Kept in a ref as well so a zone loading later
  // can apply it without waiting for a re-render.
  const [sfxVolume, setSfxVolumeState] = useState(() => {
    const v = parseFloat(localStorage.getItem('sfxVolume'));
    return Number.isFinite(v) ? v : 0.6;
  });
  const sfxVolumeRef = useRef(sfxVolume);
  const setSfxVolume = useCallback((v) => {
    sfxVolumeRef.current = v;
    setSfxVolumeState(v);
    try { localStorage.setItem('sfxVolume', String(v)); } catch { /* quota */ }
    weatherAudioRef.current?.setVolume(v);
  }, []);

  const [sfxOn, setSfxOnState] = useState(() => localStorage.getItem('weatherAudio') !== '0');
  const toggleSfx = useCallback((on) => {
    setSfxOnState(on);
    try { localStorage.setItem('weatherAudio', on ? '1' : '0'); } catch { /* quota */ }
    weatherAudioRef.current?.setEnabled(on);
  }, []);

  const saveSettings = async (draft) => {
    const gamePath = draft.gamePath.trim();
    const cexiPath = (draft.cexiPath || '').trim();
    const prevPath = settingsRef.current?.gamePath ?? '';

    if (!gamePath) {
      setSettingsError('Game path is required. Browse to your FINAL FANTASY XI install folder.');
      return;
    }
    try {
      await backend.listDir(gamePath);
    } catch {
      setSettingsError(`Game path not found:\n${gamePath}`);
      return;
    }

    localStorage.setItem('gamePath', gamePath);
    localStorage.setItem('bgColor', draft.bgColor);
    localStorage.setItem('autoPlay', draft.autoPlay ? '1' : '0');
    localStorage.setItem('autoWasdZones', draft.autoWasdZones === false ? '0' : '1');
    localStorage.setItem('cexiPath', cexiPath);
    const next = {
      ...draft,
      gamePath,
      cexiPath,
      autoWasdZones: draft.autoWasdZones !== false,
    };
    setSettings(next);
    settingsRef.current = next;
    setSettingsError('');
    setSettingsOpen(false);

    // Path changed (or first successful set) — load the default model.
    if (gamePath.toLowerCase() !== prevPath.toLowerCase() || !modelRef.current) {
      keyTablesRef.current = null;   // FFXiMain.dll keys are install-specific
      const dat = `${gamePath}\\${DEFAULT_DAT_SUFFIX}`;
      await loadModel([dat], DEFAULT_DAT_SUFFIX);
      setRevealTarget(dat.toLowerCase());
    }
  };

  const buildExportSpec = () => {
    const t = player.current;
    if (t) {
      const isSfx = t.root && t.path?.toLowerCase().includes('\\se\\');
      const type = isSfx ? 'sfx' : 'music';
      const title = t.name ?? `music${t.num?.padStart(3, '0')}`;
      const details = player.info
        ? `${player.info.formatName} · ${(player.info.sampleRate / 1000).toFixed(1)} kHz`
          + ` · ${player.info.channels === 1 ? 'mono' : 'stereo'}`
          + (player.info.durationSec ? ` · ${Math.floor(player.info.durationSec / 60)}:${String(Math.floor(player.info.durationSec % 60)).padStart(2, '0')}` : '')
        : null;
      return {
        type,
        typeLabel: isSfx ? 'Sound Effect' : 'Music',
        icon: isSfx ? 'graphic_eq' : 'music_note',
        formatIcon: 'audio_file',
        title,
        details,
        outStem: title,
        sourcePath: t.path,
      };
    }
    if (modelRef.current) {
      const info = modelInfo;
      const src = sourcePathRef.current || '';
      const datStem = (src.split(/[\\/]/).pop() || 'model').replace(/\.dat$/i, '');
      return {
        type: 'model',
        typeLabel: 'Model',
        icon: 'deployed_code',
        title: modelPath || 'model',
        details: info ? `${info.joints} joints · ${info.verts} verts · ${info.tris} tris` : null,
        datStem,
        sourcePath: src,
        animations: animsRef.current.map((g) => ({ id: g.id, frames: g.clip.numFrames })),
        cexiPath: settingsRef.current?.cexiPath || '',
      };
    }
    return null;
  };

  const handleMenuAction = (id, label) => {
    switch (id) {
      case 'settings':
        setSettingsError('');
        setSettingsOpen(true);
        break;
      case 'export': {
        const spec = buildExportSpec();
        if (spec) setExportSpec(spec);
        else setStatusText('Nothing to export — load a model or play a track first.');
        break;
      }
      case 'reset-camera':
        rendererRef.current.fitCamera();
        break;
      case 'toggle-wasd':
        setWasd(!wasdRef.current);
        break;
      case 'toggle-textures':
        setShowTex((v) => !v);
        break;
      case 'toggle-wireframe':
        setShowWireframe((v) => !v);
        break;
      case 'toggle-skeleton':
        setShowSkeleton((v) => !v);
        break;
      case 'toggle-alpha':
        setShowAlpha((v) => {
          const next = !v;
          if (rendererRef.current) rendererRef.current.showAlpha = next;
          return next;
        });
        break;
      case 'toggle-unlit':
        setShowUnlit((v) => {
          const next = !v;
          if (rendererRef.current) rendererRef.current.unlit = next;
          return next;
        });
        break;
      case 'toggle-explorer':
        setExplorerOpen((v) => !v);
        break;
      case 'toggle-collision':
        setShowCollision((v) => {
          const next = !v;
          if (rendererRef.current) rendererRef.current.showCollision = next;
          return next;
        });
        break;
      // Particle effects on/off — water, spray, clouds, sun/moon, lights. Handy
      // for telling at a glance whether an artefact comes from the effect
      // runtime or from the zone's own geometry.
      case 'toggle-effects':
        setShowEffects((v) => {
          const next = !v;
          if (rendererRef.current) rendererRef.current.showEffects = next;
          return next;
        });
        break;
      case 'toggle-navmesh':
        setShowNavmesh((v) => {
          const next = !v;
          if (rendererRef.current) rendererRef.current.showNavmesh = next;
          return next;
        });
        break;
      case 'toggle-skybox':
        setSkybox(!showSkybox);
        break;
      case 'assets-files':
        setLeftView('files');
        break;
      case 'assets-npcs':
        setLeftView('npc');
        break;
      case 'assets-characters':
        setLeftView('pc');
        break;
      case 'assets-music':
        setLeftView('music');
        break;
      case 'assets-sfx':
        setLeftView('sfx');
        break;
      case 'assets-scene':
        setLeftView('scene');
        break;
      case 'assets-zones':
        setLeftView('zones');
        break;
      case 'assets-images':
        setLeftView('images');
        break;
      case 'open-dat':
        backend.pickFile(settingsRef.current?.gamePath || null)
          .then((file) => { if (file) loadFromTree(file); })
          .catch((err) => setStatusText(`Open DAT failed: ${err.message ?? err}`));
        break;
      case 'help':
        setHelpOpen(true);
        break;
      default:
        setStatusText(`${label} — not implemented yet`);
    }
  };

  /** Frame camera on a zone placement (or all instances of a mesh type). */
  const focusBounds = useCallback((min, max) => {
    const cam = rendererRef.current?.camera;
    if (!cam || !min || !max) return;
    if (!wasdRef.current && settingsRef.current?.autoWasdZones !== false) setWasd(true);
    cam.fit(min, max);
    // fit() already reseats fly mode when active
  }, [setWasd]);

  // Drive the EnvironmentManager rather than re-resolving the DAT: changing
  // weather starts a 3.33s cross-fade of sky, fog, lighting and the two
  // weathers' particle sets, exactly as the game does it.
  const applyWeatherTime = useCallback((w, tm) => {
    setWeather(w);
    setTimeMinutes(tm);
    const env = zoneEnvManagerRef.current;
    const renderer = rendererRef.current;
    if (!renderer) return;
    try {
      if (env) {
        if (tm !== env.getTimeMinutes()) env.setTimeMinutes(tm);
        env.switchWeather(w);
        // Day/night BGM follows the clock (FFXI flips at 06:00 and 18:00).
        const hour = Math.floor(tm / 60);
        resolveZoneTrack(zoneMusicIdRef.current, hour < 6 || hour >= 18);
        renderer.skyWeather = env.getWeather();
        // The per-frame update pushes lighting from here on; set it once now so
        // a paused scene reflects the change immediately.
        renderer.setTerrainLighting(env.getTerrainLighting());
        renderer.setSkyDome(env.getSkyDome());
        return;
      }
      const envs = zoneEnvsRef.current;
      if (!envs) return;
      const resolved = resolveEnvironment(envs, w, tm);
      renderer.setTerrainLighting(terrainLightingFromEnv(resolved, tm));
      renderer.setSkyDome(skyDomeFromEnv(resolved));
      renderer.skyWeather = w;
    } catch (e) { console.warn('weather apply failed', e); }
  }, [resolveZoneTrack]);

  const focusPlacementGroup = useCallback((group) => {
    if (!group?.instances?.length) return;
    setPlcSelected(`mesh:${group.mesh}`);
    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    for (const p of group.instances) {
      const b = p.bounds;
      for (let i = 0; i < 3; i++) {
        if (b.min[i] < min[i]) min[i] = b.min[i];
        if (b.max[i] > max[i]) max[i] = b.max[i];
      }
    }
    focusBounds(min, max);
    setStatusText(`${group.mesh} · ${group.count} instance${group.count === 1 ? '' : 's'}`);
  }, [focusBounds]);

  const focusPlacementInstance = useCallback((p) => {
    if (!p) return;
    setPlcSelected(`inst:${p.name}`);
    focusBounds(p.bounds.min, p.bounds.max);
    const pos = p.rawPos.map((n) => n.toFixed(1)).join(', ');
    setStatusText(`${p.name}  #${p.index}  (${pos})`);
  }, [focusBounds]);

  const onPointerDown = (e) => {
    drag.current = { btn: e.button, x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerUp = (e) => {
    drag.current.btn = -1;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (drag.current.btn < 0) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    drag.current.x = e.clientX;
    drag.current.y = e.clientY;
    const cam = rendererRef.current.camera;
    if (wasdRef.current) {
      // Fly: any drag looks around (LMB or RMB).
      if (drag.current.btn === 0 || drag.current.btn === 2) cam.flyLook(dx, dy);
    } else if (drag.current.btn === 0) {
      cam.orbit(dx, dy);
    } else {
      cam.pan(dx, dy);
    }
  };

  // --- render --------------------------------------------------------------

  return (
    <>
      <canvas
        id="canvas"
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerMove={onPointerMove}
        onContextMenu={(e) => e.preventDefault()}
      />

      <MenuBar
        onAction={handleMenuAction}
        checks={{
          textures: showTex,
          wireframe: showWireframe,
          skeleton: showSkeleton,
          alpha: showAlpha,
          unlit: showUnlit,
          explorer: explorerOpen,
          wasd,
          collision: showCollision,
          navmesh: showNavmesh,
          skybox: showSkybox,
          effects: showEffects,
          noCollision: !hasCollision,
          noNavmesh: !hasNavmesh,
          noSkybox: !hasSkybox,
        }}
        flySpeed={flySpeed}
        fov={fov}
        onFov={setFov}
      />

      {explorerOpen && leftView === 'files' && (
        <FileTree
          rootPath={settings?.gamePath ?? ''}
          selectedPath={selectedDat}
          revealTarget={revealTarget}
          onSelectFile={loadFromTree}
          onError={(msg) => setStatusText(msg)}
        />
      )}
      {explorerOpen && leftView === 'npc' && (
        <NpcList
          onSelectEntry={loadNpcEntry}
          selectedPath={selectedDat}
          onError={(msg) => setStatusText(msg)}
        />
      )}
      {explorerOpen && leftView === 'pc' && <CharacterList pc={pc} />}
      {explorerOpen && leftView === 'music' && (
        <MusicList
          gamePath={settings?.gamePath ?? ''}
          player={player}
          onError={(msg) => setStatusText(msg)}
        />
      )}
      {explorerOpen && leftView === 'sfx' && (
        <SfxList
          gamePath={settings?.gamePath ?? ''}
          player={player}
          onError={(msg) => setStatusText(msg)}
        />
      )}
      {explorerOpen && leftView === 'scene' && (
        <SceneList
          bgColor={settings?.bgColor ?? DEFAULT_BG}
          selectedFloor={selectedFloor}
          onBg={setBg}
          onFloor={loadFloor}
          onClearFloor={clearFloor}
          onError={(msg) => setStatusText(msg)}
        />
      )}
      {explorerOpen && leftView === 'zones' && (
        <ZoneList
          selectedPath={selectedDat}
          onSelectZone={loadZone}
          onError={(msg) => setStatusText(msg)}
        />
      )}

      {explorerOpen && leftView === 'images' && (
        <ImageList
          selectedPath={imageEntry?.path}
          onSelectImage={loadImage}
          onError={(msg) => setStatusText(msg)}
        />
      )}

      {leftView === 'images' && imageDoc && (
        <>
          <ImageViewer doc={imageDoc} set={imageSet} />
          <ImageSetPanel
            file={imageEntry}
            sets={imageDoc.kind === 'sets' ? imageDoc.sets : []}
            selected={imageSet}
            onSelect={setImageSet}
          />
        </>
      )}

      {/* Stays visible while zone music plays — the play button lives in here,
          so taking the panel over would pull the controls out from under it. */}
      {leftView === 'zones' && (
        <WeatherPanel
          weathers={weatherList}
          weather={weather}
          timeMinutes={timeMinutes}
          onChange={applyWeatherTime}
          skyboxOn={showSkybox}
          onToggleSkybox={setSkybox}
          hasSkybox={hasSkybox}
          objectsOpen={!!objectGroups && plcOpen}
          bgColor={settings?.bgColor ?? DEFAULT_BG}
          onBg={setBg}
          brightness={zoneBrightness}
          onBrightness={setZoneBrightness}
          fogOn={fogOn}
          onFogOn={setFogOn}
          fogScale={fogScale}
          onFogScale={setFogScale}
          musicVolume={player.volume}
          onMusicVolume={player.setVolume}
          sfxVolume={sfxVolume}
          onSfxVolume={setSfxVolume}
          sfxOn={sfxOn}
          onToggleSfx={toggleSfx}
          zoneTrack={zoneTrack}
          zoneTrackPlaying={
            !!zoneTrack && player.playing
            && player.current?.file === zoneTrack.file && player.current?.root === zoneTrack.root
          }
          onToggleZoneMusic={toggleZoneMusic}
        />
      )}

      {objectGroups && plcOpen && (leftView === 'zones' || !player.current) && (
        <PlacementPanel
          groups={objectGroups}
          selectedKey={plcSelected}
          onSelectGroup={focusPlacementGroup}
          onSelectInstance={focusPlacementInstance}
          onClose={() => setPlcOpen(false)}
          showEnv={showSkybox}
        />
      )}

      {player.current && leftView !== 'zones' && <MusicPlayer player={player} />}

      {/* Only the views that actually put a model on screen get playback
          controls — Images/Music/SFX have their own right-hand panels. */}
      {!player.current && ORBIT_VIEWS.has(leftView) && (
        <AnimationPanel pc={leftView === 'pc' ? pc : null} anim={animControls} />
      )}

      <div id="status" className="panel mono">
        {!player.current && modelPath && selectedDat ? (
          <Tooltip content="Show in Explorer">
            <button id="statusPath" className="status-path-link" onClick={revealInExplorer}>
              {modelPath}
            </button>
          </Tooltip>
        ) : (
          <span id="statusPath">
            {player.current ? relativeName(player.current.path) : (modelPath || '—')}
          </span>
        )}
        <span className="hints">
          {player.current ? (
            `${player.playing ? 'playing' : 'paused'}: ${player.current.name ?? `music${player.current.num?.padStart(3, '0')}`}`
          ) : statusText ? (
            <>
              <span>{statusText}</span>
              {objectGroups && (
                <>
                  <span className="status-sep">·</span>
                  <button className="status-link" onClick={() => setPlcOpen((v) => !v)}>
                    {plcOpen ? 'Hide objects' : 'Objects'}
                  </button>
                </>
              )}
              {modelInfo && ORBIT_VIEWS.has(leftView) && (
                <>
                  <span className="status-sep">·</span>
                  <button className="status-link" onClick={() => setSkeletonOpen((v) => !v)}>Skeleton</button>
                  <span className="status-sep">·</span>
                  <button className="status-link" onClick={() => setDetailsOpen((v) => !v)}>Details</button>
                </>
              )}
            </>
          ) : modelInfo ? (
            <>
              <span className="status-actor">{modelInfo.name}</span>
              {!modelInfo.zone && (
                <>
                  <span className="status-sep">·</span>
                  <span>
                    {currentSchedule ? `Playing Schedule: ${currentSchedule}`
                      : currentAnim ? `Playing Animation: ${currentAnim}`
                        : 'Bind pose'}
                  </span>
                </>
              )}
              {objectGroups && (
                <>
                  <span className="status-sep">·</span>
                  <button className="status-link" onClick={() => setPlcOpen((v) => !v)}>
                    {plcOpen ? 'Hide objects' : 'Objects'}
                  </button>
                </>
              )}
              {ORBIT_VIEWS.has(leftView) && (
                <>
                  <span className="status-sep">·</span>
                  <button className="status-link" onClick={() => setSkeletonOpen((v) => !v)}>Skeleton</button>
                  <span className="status-sep">·</span>
                  <button className="status-link" onClick={() => setDetailsOpen((v) => !v)}>Details</button>
                </>
              )}
            </>
          ) : ''}
        </span>
      </div>

      {skeletonOpen && !player.current && ORBIT_VIEWS.has(leftView) && (
        <SkeletonPanel
          pose={rendererRef.current?.pose ?? null}
          onClose={() => setSkeletonOpen(false)}
        />
      )}

      {detailsOpen && modelInfo && !player.current && ORBIT_VIEWS.has(leftView) && (
        <DetailsPanel
          info={modelInfo}
          animClip={animsRef.current.find((g) => g.id === currentAnim)?.clip ?? null}
          animId={currentAnim}
          schedule={schedules.find((s) => s.id === currentSchedule) ?? null}
          onClose={() => setDetailsOpen(false)}
          onOpenTexture={openTexture}
          onPlayClip={playClipId}
        />
      )}

      {texWindows.map((w, i) => (
        <TextureModal
          key={w.id}
          tex={w.tex}
          cascadeOffset={w.cascade}
          zIndex={210 + i}
          onClose={() => closeTexture(w.id)}
          onFocus={() => focusTexture(w.id)}
        />
      ))}

      <SettingsModal
        open={settingsOpen}
        initial={settings ?? { gamePath: '', bgColor: DEFAULT_BG, autoPlay: true, autoWasdZones: true, cexiPath: '' }}
        error={settingsError}
        onSave={saveSettings}
        onClose={() => { setSettingsOpen(false); setSettingsError(''); }}
      />

      <ExportModal
        open={!!exportSpec}
        spec={exportSpec}
        onClose={() => setExportSpec(null)}
        onStatus={(msg) => setStatusText(msg)}
      />

      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />

      <LoadingOverlay
        open={!!loading}
        title={loading?.title}
        detail={loading?.detail}
      />
    </>
  );
}
