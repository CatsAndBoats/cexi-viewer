import { useMemo, useState } from 'react';
import { fmtBytes } from '../js/dat/inspect.js';
import { ENTITY_MODEL_OFFSET, GEAR_SLOTS, GEAR_TABLES, RACE_LABELS, gearIndex } from '../js/dat/modelids.js';

/** Cap on rendered file-table rows — the base table registers ~50k ids. */
const FT_MAX_ROWS = 1000;

/**
 * Assets > Data — DAT structure over the viewport. Left panel is the folder
 * tree the client walks (0x01/0x00 sections); right column is the file card
 * and a per-type census. Resources are listed with a header peek (dimensions,
 * joint counts, sound ids), never their payload.
 */
export function DataViewer({ doc, onOpenTexture, onOpenDat }) {
  if (!doc) {
    return (
      <div className="data-viewer">
        <div className="panel data-main">
          <div className="data-empty">
            <span className="icon">database</span>
            <div className="data-empty-title">Data inspector</div>
            <div className="data-empty-sub">
              Pick a .DAT from the file list to see how it's structured —
              folders, sections, and what lives in each.
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (doc.kind === 'ftable') return <FtableView doc={doc} onOpenDat={onOpenDat} />;

  if (doc.kind === 'other') {
    return (
      <div className="data-viewer">
        <div className="panel data-main">
          <div className="data-empty">
            <span className="icon">data_array</span>
            <div className="data-empty-title">{doc.label}</div>
            <div className="data-empty-sub">
              {doc.magic ? `Header magic: ${doc.magic} · ` : ''}{fmtBytes(doc.fileSize)}
            </div>
            <div className="data-empty-sub">
              This file has no 16-byte section headers to walk — it's a raw
              table, text, or stream DAT.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="data-viewer">
      <div className="panel data-main">
        <div className="data-card-title">
          <span className="icon">account_tree</span>Structure
          <span className="data-card-note mono">
            {doc.sectionCount.toLocaleString()} sections
          </span>
        </div>
        <div className="data-tree">
          <DirNode dir={doc.root} depth={0} onOpenTexture={onOpenTexture} />
        </div>
      </div>

      <div className="data-side">
        <div className="panel data-card">
          <div className="data-card-title"><span className="icon">description</span>File</div>
          <Row label="Path" value={doc.path} mono />
          <Row label="Size" value={fmtBytes(doc.fileSize)} />
          <Row label="Sections" value={doc.sectionCount.toLocaleString()} />
          <Row label="Folders" value={doc.dirCount.toLocaleString()} />
          <Row label="Depth" value={doc.maxDepth} />
          {doc.warnings.map((w, i) => (
            <div key={i} className="data-warning">
              <span className="icon">warning</span>{w}
            </div>
          ))}
        </div>

        <div className="panel data-card data-census">
          <div className="data-card-title"><span className="icon">category</span>Contents</div>
          <div className="data-census-rows">
            {doc.summary.map((row) => (
              <div key={row.type} className="data-census-row">
                <span className="icon">{row.icon}</span>
                <span className="data-census-name">{row.name}</span>
                <span className="data-census-count mono">{row.count.toLocaleString()}</span>
                <span className="data-census-bytes mono">{fmtBytes(row.bytes)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * FTABLE/VTABLE pair: every registered file id and the DAT it resolves to.
 * The search box narrows by id (numeric query) or by path substring; rows
 * click through to inspect the named DAT.
 */
const FT_CATS = [
  { id: 'all', label: 'All ids' },
  { id: 'gear', label: 'Gear' },
  { id: 'entity', label: 'Mobs & NPCs' },
];

function FtableView({ doc, onOpenDat }) {
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState('all');

  const entryById = useMemo(() => new Map(doc.entries.map((e) => [e.id, e])), [doc]);

  // Gear rows in table order (race → slot → model id), registered ids only.
  const gearRows = useMemo(() => {
    const rows = [];
    for (const [id, g] of gearIndex()) {
      const e = entryById.get(id);
      if (!e) continue;
      rows.push({
        ...e,
        modelId: g.modelId,
        slot: g.slot,
        races: g.races,
        raceLabel: g.races.map((r) => RACE_LABELS[r] ?? r).join(' / '),
      });
    }
    return rows;
  }, [entryById]);

  // Everything in the monster/NPC range that the gear tables don't claim.
  const entityRows = useMemo(() => {
    const gi = gearIndex();
    return doc.entries
      .filter((e) => e.id >= ENTITY_MODEL_OFFSET && !gi.has(e.id))
      .map((e) => ({ ...e, modelId: e.id - ENTITY_MODEL_OFFSET }));
  }, [doc]);

  const rows = cat === 'gear' ? gearRows : cat === 'entity' ? entityRows : doc.entries;

  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return rows;
    // Every space-separated token must match something on the row: a number
    // matches the model id (gear/mob views) or the file id; text matches the
    // DAT path, race, or slot ("mithra body", "ROM/303/", "172").
    const tokens = q.toLowerCase().split(/\s+/);
    return rows.filter((e) => tokens.every((t) => {
      if (/^\d+$/.test(t)) {
        const n = parseInt(t, 10);
        if (e.modelId != null) return e.modelId === n || e.id === n;
        return e.id === n || String(e.id).startsWith(t);
      }
      if (e.dat.toLowerCase().includes(t)) return true;
      if (e.raceLabel && (e.raceLabel.toLowerCase().includes(t) || e.races.some((r) => r.toLowerCase().includes(t)))) return true;
      if (e.slot && e.slot.startsWith(t)) return true;
      return false;
    }));
  }, [rows, query]);

  // Race → slot → registered DATs, for the browsable tree (no query). Taru ♂/♀
  // each get their full set here — shared file_ids appear under both, which is
  // what a per-race browse should show.
  const gearTree = useMemo(() => {
    const races = [];
    for (const [race, slots] of Object.entries(GEAR_TABLES)) {
      const slotNodes = [];
      let raceCount = 0;
      for (const slot of GEAR_SLOTS) {
        const groups = slots[slot];
        if (!groups) continue;
        const slotRows = [];
        let modelId = 0;
        for (const [base, count] of groups) {
          for (let i = 0; base !== 0 && i < count; i++) {
            const e = entryById.get(base + i);
            if (e) slotRows.push({ ...e, modelId: modelId + i, slot });
          }
          modelId += count;
        }
        if (slotRows.length) {
          slotNodes.push({ slot, rows: slotRows });
          raceCount += slotRows.length;
        }
      }
      races.push({ race, label: RACE_LABELS[race] ?? race, slots: slotNodes, count: raceCount });
    }
    return races;
  }, [entryById]);

  // Gear view: census per race; otherwise per ROM root.
  const census = useMemo(() => {
    if (cat !== 'gear') return null;
    const bySlot = new Map(GEAR_SLOTS.map((s) => [s, 0]));
    const byRace = new Map();
    for (const r of gearRows) {
      bySlot.set(r.slot, (bySlot.get(r.slot) ?? 0) + 1);
      for (const race of r.races) byRace.set(race, (byRace.get(race) ?? 0) + 1);
    }
    return {
      races: [...byRace.entries()].map(([race, count]) => ({ label: RACE_LABELS[race] ?? race, count })),
      slots: [...bySlot.entries()].filter(([, c]) => c).map(([slot, count]) => ({ label: slot, count })),
    };
  }, [cat, gearRows]);

  const shown = filtered.length > FT_MAX_ROWS ? filtered.slice(0, FT_MAX_ROWS) : filtered;
  const label = doc.romIdx === 1 ? 'FTABLE / VTABLE' : `FTABLE${doc.romIdx} / VTABLE${doc.romIdx}`;

  return (
    <div className="data-viewer">
      <div className="panel data-main">
        <div className="data-card-title">
          <span className="icon">table_rows</span>File table
          <span className="data-card-note mono">
            {filtered.length === rows.length
              ? `${rows.length.toLocaleString()} entries`
              : `${filtered.length.toLocaleString()} of ${rows.length.toLocaleString()}`}
          </span>
        </div>
        <div className="list-search-wrap">
          <div className="data-cats">
            {FT_CATS.map((c) => (
              <button
                key={c.id}
                className={`data-cat${cat === c.id ? ' on' : ''}`}
                onClick={() => setCat(c.id)}
              >
                {c.label}
              </button>
            ))}
          </div>
          <span className="icon">search</span>
          <input
            className="list-search"
            placeholder={cat === 'gear' ? 'Filter by race, slot, model id or path…'
              : cat === 'entity' ? 'Filter by model id or DAT path…'
                : 'Filter by file id or DAT path…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button className="list-search-clear" onClick={() => setQuery('')} title="Clear">
              <span className="icon">close</span>
            </button>
          )}
        </div>
        <div className="data-tree">
          {cat === 'gear' && !query.trim() ? (
            gearTree.map((r) => <GearRaceNode key={r.race} node={r} onOpenDat={onOpenDat} />)
          ) : (
            <>
              {shown.map((e) => <FtRow key={e.id} e={e} onOpenDat={onOpenDat} />)}
              {filtered.length > FT_MAX_ROWS && (
                <div className="data-ft-more">
                  Showing the first {FT_MAX_ROWS.toLocaleString()} of {filtered.length.toLocaleString()} — narrow the filter to see the rest.
                </div>
              )}
              {filtered.length === 0 && (
                <div className="data-ft-more">No entries match “{query}”.</div>
              )}
            </>
          )}
        </div>
      </div>

      <div className="data-side">
        <div className="panel data-card">
          <div className="data-card-title"><span className="icon">description</span>File</div>
          <Row label="Tables" value={label} mono />
          <Row label="Path" value={doc.path} mono />
          <Row label="Sizes" value={`${fmtBytes(doc.fileSize)} + ${fmtBytes(doc.siblingSize)}`} />
          <Row label="Capacity" value={doc.capacity.toLocaleString()} />
          <Row label="Registered" value={doc.registered.toLocaleString()} />
          <Row label="Free" value={(doc.capacity - doc.registered).toLocaleString()} />
        </div>

        <div className="panel data-card data-census">
          <div className="data-card-title">
            <span className="icon">category</span>{census ? 'Gear models' : 'By ROM root'}
          </div>
          <div className="data-census-rows">
            {census ? (
              <>
                {census.races.map((r) => (
                  <div key={r.label} className="data-census-row">
                    <span className="icon">person</span>
                    <span className="data-census-name">{r.label}</span>
                    <span className="data-census-count mono">{r.count.toLocaleString()}</span>
                  </div>
                ))}
                <div className="data-census-sep" />
                {census.slots.map((s) => (
                  <div key={s.label} className="data-census-row">
                    <span className="icon">checkroom</span>
                    <span className="data-census-name">{s.label}</span>
                    <span className="data-census-count mono">{s.count.toLocaleString()}</span>
                  </div>
                ))}
              </>
            ) : doc.romCounts.map((r) => (
              <div key={r.rom} className="data-census-row">
                <span className="icon">folder</span>
                <span className="data-census-name mono">{r.rom === 1 ? 'ROM' : `ROM${r.rom}`}</span>
                <span className="data-census-count mono">{r.count.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** One file-table row: model/file id, optional race+slot, DAT path. */
function FtRow({ e, onOpenDat, indent = 0 }) {
  return (
    <div
      className="data-row data-ft-row"
      style={indent ? { paddingLeft: 8 + indent * 14 } : undefined}
      title={`file id ${e.id} · FTABLE 0x${e.ftVal.toString(16).toUpperCase().padStart(4, '0')} (subdir ${e.ftVal >> 7} · file ${e.ftVal & 0x7f}) — click to inspect`}
      onClick={() => onOpenDat?.(e.dat)}
    >
      <span className="data-ft-id mono">{e.modelId ?? e.id}</span>
      {e.raceLabel && <span className="data-type">{e.raceLabel} {e.slot}</span>}
      <span className="data-id mono">{e.dat}</span>
      <span className="data-size mono">{e.modelId != null ? `id ${e.id}` : `ROM ${e.rom}`}</span>
    </div>
  );
}

/** Gear tree: race → slot → DAT rows. Races open flat; slots expand on click. */
function GearRaceNode({ node, onOpenDat }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="data-node">
      <div className="data-row data-dir-row" onClick={() => setOpen((v) => !v)}>
        <span className={`icon data-caret${open ? ' open' : ''}`}>chevron_right</span>
        <span className="icon data-kind">person</span>
        <span className="data-id mono">{node.label}</span>
        <span className="data-dir-counts mono">{node.count.toLocaleString()} models</span>
      </div>
      {open && node.slots.map((s) => (
        <GearSlotNode key={s.slot} node={s} onOpenDat={onOpenDat} />
      ))}
    </div>
  );
}

function GearSlotNode({ node, onOpenDat }) {
  const [open, setOpen] = useState(false);
  const label = node.slot[0].toUpperCase() + node.slot.slice(1);
  return (
    <div className="data-node">
      <div className="data-row data-dir-row" style={{ paddingLeft: 22 }} onClick={() => setOpen((v) => !v)}>
        <span className={`icon data-caret${open ? ' open' : ''}`}>chevron_right</span>
        <span className="icon data-kind">checkroom</span>
        <span className="data-id mono">{label}</span>
        <span className="data-dir-counts mono">{node.rows.length.toLocaleString()} models</span>
      </div>
      {open && node.rows.map((e) => (
        <FtRow key={e.id} e={{ ...e, raceLabel: null }} onOpenDat={onOpenDat} indent={3} />
      ))}
    </div>
  );
}

function DirNode({ dir, depth, onOpenTexture }) {
  const [open, setOpen] = useState(depth < 4);
  // Folder rows summarise what's inside so a collapsed tree still reads.
  const counts = useMemo(() => {
    let dirs = 0, res = 0;
    const walk = (d) => {
      for (const c of d.children) {
        if (c.kind === 'dir') { dirs++; walk(c); } else res++;
      }
    };
    walk(dir);
    return { dirs, res };
  }, [dir]);

  const isRoot = depth === 0;
  return (
    <div className="data-node">
      {!isRoot && (
        <div
          className="data-row data-dir-row"
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => setOpen((v) => !v)}
        >
          <span className={`icon data-caret${open ? ' open' : ''}`}>chevron_right</span>
          <span className="icon data-kind">folder</span>
          <span className="data-id mono">{dir.id || '(unnamed)'}</span>
          <span className="data-dir-counts mono">
            {counts.dirs > 0 && `${counts.dirs} folders · `}{counts.res} items
          </span>
        </div>
      )}
      {(isRoot || open) && dir.children.map((c, i) => (
        c.kind === 'dir'
          ? <DirNode key={`d${i}`} dir={c} depth={depth + 1} onOpenTexture={onOpenTexture} />
          : <ResRow key={`r${i}`} res={c} depth={depth + 1} onOpenTexture={onOpenTexture} />
      ))}
    </div>
  );
}

function ResRow({ res, depth, onOpenTexture }) {
  const clickable = !!res.textureName && !!onOpenTexture;
  return (
    <div
      className={`data-row data-res-row${clickable ? ' data-res-click' : ''}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      title={`offset 0x${res.offset.toString(16).toUpperCase()}${res.flags.length ? ` · ${res.flags.join(', ')}` : ''}`}
      onClick={clickable ? () => onOpenTexture(res.textureName) : undefined}
    >
      <span className="data-caret-pad" />
      <span className="icon data-kind">{res.icon}</span>
      <span className="data-id mono">{res.id || '····'}</span>
      <span className="data-type">{res.name}</span>
      {res.detail && <span className="data-detail mono">{res.detail}</span>}
      {res.flags.length > 0 && <span className="data-flags mono">{res.flags.join(' ')}</span>}
      <span className="data-size mono">{fmtBytes(res.size)}</span>
    </div>
  );
}

function Row({ label, value, mono }) {
  return (
    <div className="details-row">
      <span className="details-row-label">{label}</span>
      <span className={`details-row-value${mono ? ' mono' : ''}`}>{value}</span>
    </div>
  );
}
