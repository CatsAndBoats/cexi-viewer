import { useEffect, useState } from 'react';
import { Button, Checkbox, Field } from '@headlessui/react';

const DEFAULT_FOG_FAR = 45;

// floors.json rows: { zone, spec: "rom/dir/file", fourcc } — the fourcc names a
// 0x20 texture section that becomes the tiled ground plane.
async function loadFloors() {
  const groups = new Map();   // zone -> [{ spec, fourcc }]
  try {
    const res = await fetch('lists/floors.json');
    if (res.ok) {
      for (const { zone, spec, fourcc } of await res.json()) {
        if (!groups.has(zone)) groups.set(zone, []);
        groups.get(zone).push({ spec, fourcc });
      }
    }
  } catch { /* list optional */ }
  return [...groups.entries()].map(([zone, floors]) => ({ zone, floors }));
}

export function SceneList({ bgColor, onBg, onFloor, onClearFloor, onFog, selectedFloor, onError }) {
  const [groups, setGroups] = useState(null);
  const [fogOn, setFogOn] = useState(() => localStorage.getItem('fogOn') === '1');
  const [fogFar, setFogFar] = useState(() => {
    const v = parseFloat(localStorage.getItem('fogFar'));
    return Number.isFinite(v) ? v : DEFAULT_FOG_FAR;
  });

  useEffect(() => { loadFloors().then(setGroups).catch(() => setGroups([])); }, []);

  // Push fog state to the renderer (and persist) whenever it changes.
  useEffect(() => {
    onFog?.({ enabled: fogOn, far: fogFar, near: fogFar * 0.25 });
    localStorage.setItem('fogOn', fogOn ? '1' : '0');
    localStorage.setItem('fogFar', String(fogFar));
  }, [fogOn, fogFar, onFog]);

  return (
    <div id="tree" className="panel scene-panel">
      <div className="scene-controls">
        <div className="scene-ctrl">
          <span className="scene-ctrl-label">Background</span>
          <input type="color" value={bgColor} onChange={(e) => onBg?.(e.target.value)} />
        </div>

        <Field className="scene-ctrl">
          <label className="switch">
            <input type="checkbox" checked={fogOn} onChange={(e) => setFogOn(e.target.checked)} />
            <span className="track" />
          </label>
          <span className="scene-ctrl-label">Fog</span>
        </Field>

        <div className="scene-ctrl scene-fog-slider">
          <span className="scene-ctrl-label">Distance</span>
          <input type="range" min="8" max="120" step="1" value={fogFar} disabled={!fogOn}
            onChange={(e) => setFogFar(+e.target.value)} className="vol-slider"
            style={{ '--fill': `${((fogFar - 8) / (120 - 8)) * 100}%` }} />
          <span className="mono scene-fog-num">{fogFar}</span>
        </div>

        <Button className="scene-clear" onClick={onClearFloor}>
          <span className="icon">layers_clear</span>Remove floor
        </Button>
      </div>

      <div className="scene-floors">
        {groups === null && <div className="side-note">Loading floors…</div>}
        {groups?.map(({ zone, floors }) => (
          <SceneZone key={zone} zone={zone} floors={floors}
            selectedFloor={selectedFloor} onFloor={onFloor} onError={onError} />
        ))}
      </div>
    </div>
  );
}

function SceneZone({ zone, floors, selectedFloor, onFloor }) {
  const [open, setOpen] = useState(false);
  const single = floors.length === 1;

  const load = (f) => onFloor?.(f.spec, f.fourcc);
  const keyOf = (f) => `${f.spec}:${f.fourcc}`;

  if (single) {
    const f = floors[0];
    return (
      <div className={`node${selectedFloor === keyOf(f) ? ' selected' : ''}`}>
        <div className="row" onClick={() => load(f)}>
          <span className="caret icon"></span>
          <span className="kind icon">grass</span>
          <span>{zone}</span>
          <span className="mono-small scene-fourcc">{f.fourcc}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`node${open ? ' open' : ''}`}>
      <div className="row" onClick={() => setOpen(!open)}>
        <span className="caret icon">chevron_right</span>
        <span className="kind icon">grass</span>
        <span>{zone}</span>
        <span className="badge">{floors.length}</span>
      </div>
      {open && (
        <div className="children">
          {floors.map((f) => (
            <div key={keyOf(f)} className={`node${selectedFloor === keyOf(f) ? ' selected' : ''}`}>
              <div className="row" onClick={() => load(f)}>
                <span className="caret icon"></span>
                <span className="kind icon">texture</span>
                <span className="mono-small">{f.fourcc}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
