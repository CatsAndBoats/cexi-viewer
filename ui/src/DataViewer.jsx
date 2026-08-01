import { useMemo, useState } from 'react';
import { fmtBytes } from '../js/dat/inspect.js';

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
function FtableView({ doc, onOpenDat }) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return doc.entries;
    if (/^\d+$/.test(q)) {
      const n = parseInt(q, 10);
      // Exact id first, then ids sharing the typed prefix (typing 51 narrows
      // toward 51234 instead of showing nothing until the id is complete).
      return doc.entries.filter((e) => e.id === n || String(e.id).startsWith(q));
    }
    const needle = q.toLowerCase();
    return doc.entries.filter((e) => e.dat.toLowerCase().includes(needle));
  }, [doc, query]);

  const shown = filtered.length > FT_MAX_ROWS ? filtered.slice(0, FT_MAX_ROWS) : filtered;
  const label = doc.romIdx === 1 ? 'FTABLE / VTABLE' : `FTABLE${doc.romIdx} / VTABLE${doc.romIdx}`;

  return (
    <div className="data-viewer">
      <div className="panel data-main">
        <div className="data-card-title">
          <span className="icon">table_rows</span>File table
          <span className="data-card-note mono">
            {filtered.length === doc.entries.length
              ? `${doc.entries.length.toLocaleString()} entries`
              : `${filtered.length.toLocaleString()} of ${doc.entries.length.toLocaleString()}`}
          </span>
        </div>
        <div className="list-search-wrap">
          <span className="icon">search</span>
          <input
            className="list-search"
            placeholder="Filter by file id or DAT path…"
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
          {shown.map((e) => (
            <div
              key={e.id}
              className="data-row data-ft-row"
              title={`FTABLE 0x${e.ftVal.toString(16).toUpperCase().padStart(4, '0')} (subdir ${e.ftVal >> 7} · file ${e.ftVal & 0x7f}) — click to inspect`}
              onClick={() => onOpenDat?.(e.dat)}
            >
              <span className="data-ft-id mono">{e.id}</span>
              <span className="data-id mono">{e.dat}</span>
              <span className="data-size mono">ROM {e.rom}</span>
            </div>
          ))}
          {filtered.length > FT_MAX_ROWS && (
            <div className="data-ft-more">
              Showing the first {FT_MAX_ROWS.toLocaleString()} of {filtered.length.toLocaleString()} — narrow the filter to see the rest.
            </div>
          )}
          {filtered.length === 0 && (
            <div className="data-ft-more">No entries match “{query}”.</div>
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
          <div className="data-card-title"><span className="icon">category</span>By ROM root</div>
          <div className="data-census-rows">
            {doc.romCounts.map((r) => (
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
