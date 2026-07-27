import { useEffect, useRef, useState } from 'react';
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/react';

// All character data comes fully resolved from lists/characters.json (baked by
// dev/bake-lists.mjs): races with base skeleton + per-weapon-type battle-idle
// DATs, per-race gear/face items, and actions (Basic + Battle styles + weapon
// skills) with every motion DAT already attached. No CSV/spec parsing here.

const SLOTS = [
  { key: 'face', label: 'Face', section: null },
  { key: 'main', label: 'Main', section: 'Weapon' },
  { key: 'sub', label: 'Sub', section: 'Weapon' },
  { key: 'range', label: 'Ranged', section: 'Weapon' },
  { key: 'head', label: 'Head', section: 'Armor' },
  { key: 'body', label: 'Body', section: 'Armor' },
  { key: 'hands', label: 'Hands', section: 'Armor' },
  { key: 'legs', label: 'Legs', section: 'Armor' },
  { key: 'feet', label: 'Feet', section: 'Armor' },
];

// ---------------------------------------------------------------------------

/**
 * Character composer state. Owns the race index, the per-race slot/action
 * lists, and the current selections; assembles the merged DAT path list and
 * calls onLoad whenever it changes. Lives in App so the viewbar Action combo
 * and the left panel share one instance.
 */
const PC_STATE_KEY = 'pcState';

/** Persisted composer selections: { race, sel, actionGroup, action }. */
function loadPcState() {
  try { return JSON.parse(localStorage.getItem(PC_STATE_KEY) || 'null') ?? {}; } catch { return {}; }
}

export function useCharacter({ enabled, onLoad, onError }) {
  const saved = useRef(loadPcState());
  const [races, setRaces] = useState(null);
  const [race, setRaceState] = useState(saved.current.race ?? '');
  const [slots, setSlots] = useState(null);     // { slotKey: items[] | null }
  // Race id the current slots/sel/actions belong to. Load waits until this
  // matches `race` so a switch never merges the new base onto the previous
  // race's face/gear (shared labels like "F1A" make that easy to miss).
  const [slotsRace, setSlotsRace] = useState('');
  const [sel, setSel] = useState({});           // slotKey -> item id
  const [actions, setActions] = useState([]);
  const [actionGroup, setActionGroupState] = useState('');
  const [action, setAction] = useState('');
  const lastKey = useRef('');
  const lastRace = useRef('');                  // race of the last onLoad (camera keep)
  const restored = useRef(false);               // saved selections applied?
  const carry = useRef({ gear: {}, actionKey: null });   // selections to carry across a race switch
  const raceData = useRef(new Map());           // race id -> full characters.json entry
  const prevEnabled = useRef(false);
  const cbRef = useRef({});
  cbRef.current = { onLoad, onError };

  /** UI race pick: invalidate slot ownership in the same event so the load
   *  effect cannot run one frame with the new race + old face/gear paths. */
  const setRace = (id) => {
    if (id === race) return;
    setSlotsRace('');
    lastKey.current = '';
    lastRace.current = '';
    setRaceState(id);
  };

  const groupOf = (a) => a.group ?? 'Other';
  const actionGroups = [...new Set(actions.map(groupOf))];
  const actionEntries = actions.filter((a) => groupOf(a) === actionGroup);

  /** Switching category also selects its first entry. */
  const setActionGroup = (g) => {
    setActionGroupState(g);
    setAction(actions.find((a) => groupOf(a) === g)?.id ?? '');
  };

  // Character data (once, on first enable)
  useEffect(() => {
    if (!enabled || races !== null) return;
    (async () => {
      try {
        const res = await fetch('lists/characters.json');
        if (!res.ok) throw new Error(`${res.status} characters.json`);
        const data = await res.json();
        raceData.current = new Map(data.races.map((r) => [r.id, r]));
        const rs = data.races.map((r) => ({ id: r.id, label: r.label, base: r.base }));
        setRaces(rs);
        setRaceState((r) => (rs.some((x) => x.id === r) ? r : rs[0]?.id || ''));
      } catch (err) {
        cbRef.current.onError?.(`Failed to load character lists: ${err.message ?? err}`);
        setRaces([]);
      }
    })();
  }, [enabled, races]);

  // Mirror the current selections by *label* so a race switch can carry them
  // over (item ids are race-specific, labels are shared). Deps exclude race, so
  // this holds the previous race's picks while the per-race effect reloads.
  useEffect(() => {
    const gear = {};
    for (const s of SLOTS) {
      const it = slots?.[s.key]?.find((x) => x.id === sel[s.key]);
      if (it) gear[s.key] = it.label;
    }
    const a = actions.find((x) => x.id === action);
    carry.current = { gear, actionKey: a ? `${a.group ?? ''}|${a.label}` : null };
  }, [slots, sel, actions, action]);

  // Per-race lists (all in memory once characters.json is loaded); defaults:
  // the slot's "None" entry when it has one, else first.
  useEffect(() => {
    if (!race || !races?.length) return;
    const entry = raceData.current.get(race);
    if (!entry) return;

    const slotMap = {};
    const defaults = {};
    for (const s of SLOTS) {
      const items = entry.slots?.[s.key] ?? null;
      slotMap[s.key] = items;
      if (items?.length) {
        const none = items.find((it) => it.label.toLowerCase() === 'none');
        defaults[s.key] = (none ?? items[0]).id;
      }
    }
    const acts = entry.actions ?? [];

    // Restore the saved selections once, and only for the race they belong to
    // (gear lists are race-specific; a manual race switch carries by label).
    const s = saved.current;
    const restoring = !restored.current && s.race === race;
    restored.current = true;
    const startSel = { ...defaults };
    let startGroup = acts[0]?.group ?? (acts.length ? 'Other' : '');
    let startAction = acts[0]?.id ?? '';
    if (restoring) {
      for (const [k, id] of Object.entries(s.sel ?? {})) {
        if (slotMap[k]?.some((it) => it.id === id)) startSel[k] = id;
      }
      const act = acts.find((a) => a.id === s.action);
      if (act) { startGroup = act.group ?? 'Other'; startAction = act.id; }
    } else if (carry.current.actionKey || Object.keys(carry.current.gear).length) {
      // Race switch: carry gear + action over by label (item ids differ per race).
      for (const s2 of SLOTS) {
        const want = carry.current.gear[s2.key];
        const hit = want && slotMap[s2.key]?.find((it) => it.label === want);
        if (hit) startSel[s2.key] = hit.id;
      }
      const [g, l] = (carry.current.actionKey ?? '').split('|');
      const act = acts.find((a) => (a.group ?? '') === g && a.label === l);
      if (act) { startGroup = act.group ?? 'Other'; startAction = act.id; }
    }

    setSlots(slotMap);
    setSlotsRace(race);
    setSel(startSel);
    setActions(acts);
    setActionGroupState(startGroup);
    setAction(startAction);
  }, [race, races]);

  // Persist selections (restored on next launch).
  useEffect(() => {
    if (!races?.length || !race) return;
    try {
      localStorage.setItem(PC_STATE_KEY, JSON.stringify({ race, sel, actionGroup, action }));
    } catch { /* quota / private mode */ }
  }, [races, race, sel, actionGroup, action]);

  // Re-enter the Characters view: allow a reload (and a camera re-fit) even if
  // selections didn't change — another view may have replaced the model.
  useEffect(() => {
    if (enabled && !prevEnabled.current) { lastKey.current = ''; lastRace.current = ''; }
    prevEnabled.current = enabled;
  }, [enabled]);

  // Assemble + load. Skips while selections still point at another race's lists
  // (race updates one render before the per-race effect rebuilds slots/sel —
  // loading then would merge the new base onto the previous race's face/gear).
  useEffect(() => {
    if (!enabled || !races?.length || !slots || slotsRace !== race) return;
    const r = races.find((x) => x.id === race);
    if (!r) return;
    // The base DAT holds only the lower-body motion slot; motionExtra adds the
    // upper-body + waist companion packs (baked in dev/bake-lists.mjs) so
    // locomotion animates the whole body, not just the legs. They stay out of
    // focusPaths so they feed playback without flooding the viewbar lists.
    const paths = [r.base, ...(raceData.current.get(race)?.motionExtra ?? [])];
    const weaponSlots = {};
    // Per-part breakdown for the Details panel (label + which DATs each slot contributed).
    const parts = [{ key: 'race', label: 'Race', itemLabel: r.label, paths: [r.base] }];
    for (const s of SLOTS) {
      const items = slots[s.key];
      if (!items?.length) continue;
      const item = items.find((it) => it.id === sel[s.key]);
      if (!item) return;
      paths.push(...item.paths);
      if (s.key === 'main' || s.key === 'sub') weaponSlots[s.key] = item.paths;
      if (item.paths.length) {
        parts.push({
          key: s.key,
          label: s.section === 'Weapon' ? `Weapon: ${s.label}` : s.label,
          itemLabel: item.label,
          paths: item.paths,
        });
      }
    }
    const act = actions.find((a) => a.id === action);
    if (action && !act) return;
    // Focus = the schedule DATs only. Motion packs still load (schedules
    // resolve clips out of them) but must not flood the viewbar lists.
    const focusPaths = act ? [...act.paths] : [];
    if (act) paths.push(...focusPaths, ...(act.motionPaths ?? []));

    const unique = [...new Set(paths)];
    // Prefix race so a shared face label never collapses two skeletons into one key.
    const key = `${race}|${unique.join('|')}`;
    if (key === lastKey.current) return;
    lastKey.current = key;
    cbRef.current.onLoad?.({
      name: r.label,
      paths: unique,
      focusPaths,
      weaponSlots,
      // The equipped weapon rests in its own battle stance (btl): App resolves
      // the right entry by the weapon's animation type after parsing it.
      battleTable: raceData.current.get(race)?.battleByType ?? null,
      parts,
      keepCamera: lastRace.current === race,   // gear/action swap on the same actor
    });
    lastRace.current = race;
  }, [enabled, races, race, slots, slotsRace, sel, actions, action]);

  return {
    races, race, setRace, slots, sel, setSel,
    actionGroups, actionGroup, setActionGroup, actionEntries, action, setAction,
  };
}

// ---------------------------------------------------------------------------

function groupRows(items) {
  // Headers only when the list actually spans multiple groups.
  const multi = new Set(items.map((it) => it.group ?? null)).size > 1;
  const rows = [];
  let last = null;
  for (const it of items) {
    if (multi && it.group && it.group !== last) rows.push({ header: it.group, key: `h${rows.length}` });
    last = it.group;
    rows.push({ item: it, key: it.id });
  }
  return rows;
}

/**
 * Native-select style arrow keys: while a combo's button is focused and its
 * panel is CLOSED, ArrowUp/ArrowDown steps the value directly (clamped, no
 * wrap) so gear/animation can be flipped through quickly. Headless UI returns
 * focus to the button after each pick, so cycling chains naturally.
 *
 * Must be attached with onKeyDownCapture: ListboxButton's own keydown opens
 * the panel and stops propagation, so a bubble-phase handler never runs.
 */
export function cycleOnArrow(e, open, ids, value, onChange) {
  if (open || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
  if (ids.length === 0) return;
  e.preventDefault();
  e.stopPropagation();
  const dir = e.key === 'ArrowDown' ? 1 : -1;
  const next = ids[Math.min(Math.max(ids.indexOf(value) + dir, 0), ids.length - 1)];
  if (next !== undefined && next !== value) onChange(next);
}

function PcCombo({ value, items, onChange, placeholder = '—' }) {
  const current = items.find((i) => i.id === value);
  return (
    <Listbox value={value ?? ''} onChange={onChange}>
      {({ open }) => (
        <div
          style={{ display: 'contents' }}
          onKeyDownCapture={(e) => cycleOnArrow(e, open, items.map((i) => i.id), value, onChange)}
        >
          <ListboxButton className="combo-input">
            <span className="combo-value">{current?.label ?? placeholder}</span>
            <span className="icon combo-chevron">unfold_more</span>
          </ListboxButton>
          <ListboxOptions anchor="bottom start" className="combo-options">
            {groupRows(items).map((r) =>
              r.header !== undefined
                ? <div key={r.key} className="combo-group">{r.header}</div>
                : (
                  <ListboxOption key={r.key} value={r.item.id} className="combo-option">
                    {r.item.label}
                  </ListboxOption>
                ),
            )}
          </ListboxOptions>
        </div>
      )}
    </Listbox>
  );
}

/** Viewbar "Action" selectors: category (Battle, Emote, G. Katana…) + entry. */
export function ActionCombos({ pc }) {
  const { actionGroups, actionGroup, setActionGroup, actionEntries, action, setAction } = pc;
  if (actionGroups.length === 0) return null;
  return (
    <>
      <span className="label">Action</span>
      <PcCombo
        value={actionGroup}
        items={actionGroups.map((g) => ({ id: g, label: g }))}
        onChange={setActionGroup}
      />
      <PcCombo value={action} items={actionEntries} onChange={setAction} placeholder="— none —" />
    </>
  );
}

export function CharacterList({ pc }) {
  const { races, race, setRace, slots, sel, setSel } = pc;
  const raceItems = (races ?? []).map((r) => ({ id: r.id, label: r.label }));
  const pick = (key) => (id) => setSel((s) => ({ ...s, [key]: id }));

  const slotCtrl = (s) => {
    const items = slots?.[s.key];
    if (!items?.length) return null;
    return (
      <div className="pc-ctrl" key={s.key}>
        <span className="pc-ctrl-label">{s.label}</span>
        <PcCombo value={sel[s.key]} items={items} onChange={pick(s.key)} />
      </div>
    );
  };

  const section = (name) => {
    const ctrls = SLOTS.filter((s) => s.section === name).map(slotCtrl).filter(Boolean);
    if (ctrls.length === 0) return null;
    return (
      <>
        <div className="side-separator">{name}</div>
        {ctrls}
      </>
    );
  };

  return (
    <div id="tree" className="panel pc-panel">
      <div className="pc-scroll">
        {races === null && <div className="side-note">Loading character lists…</div>}
        {races?.length === 0 && <div className="side-note">No PC lists found.</div>}
        {races?.length > 0 && (
          <>
            <div className="pc-ctrl">
              <span className="pc-ctrl-label">Race</span>
              <PcCombo value={race} items={raceItems} onChange={setRace} />
            </div>
            {slotCtrl(SLOTS[0]) /* Face */}
            {section('Weapon')}
            {section('Armor')}
          </>
        )}
      </div>
      <div className="pc-footer">
        <div className="side-separator">GearSets</div>
        <div className="side-note">Work in progress.</div>
      </div>
    </div>
  );
}
