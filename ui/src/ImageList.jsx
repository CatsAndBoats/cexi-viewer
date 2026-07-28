import { useEffect, useMemo, useState } from 'react';

// images.json (from dev/bake-images.mjs): [{ id, name, entries: [{ name, path }] }]
// path is backslash `ROM…\N.DAT`, relative to the game directory.

async function loadImages() {
  const res = await fetch('lists/images.json');
  if (!res.ok) throw new Error(`${res.status} lists/images.json`);
  return res.json();
}

export function ImageList({ selectedPath, onSelectImage, onError }) {
  const [cats, setCats] = useState(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await loadImages();
        if (!cancelled) setCats(Array.isArray(list) ? list : []);
      } catch (err) {
        if (!cancelled) {
          setCats([]);
          onError?.(`Failed to load images: ${err.message ?? err}`);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [onError]);

  const groups = useMemo(() => {
    if (!cats) return null;
    const q = query.trim().toLowerCase();
    return cats
      .map((c) => ({
        key: c.id,
        label: c.name,
        entries: q
          ? c.entries.filter((e) => e.name.toLowerCase().includes(q)
            || e.path.toLowerCase().includes(q))
          : c.entries,
      }))
      .filter((g) => g.entries.length);
  }, [cats, query]);

  const total = cats?.reduce((n, c) => n + c.entries.length, 0) ?? 0;
  const shown = groups?.reduce((n, g) => n + g.entries.length, 0) ?? 0;

  return (
    <div id="tree" className="panel zone-panel">
      <div className="zone-search">
        <span className="icon">search</span>
        <input
          type="search"
          placeholder="Filter images…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
      </div>
      {cats === null && <div className="side-note">Loading images…</div>}
      {cats && total === 0 && <div className="side-note">No images in lists/images.json.</div>}
      {cats && total > 0 && shown === 0 && <div className="side-note">No images match “{query}”.</div>}
      {groups?.map((g) => (
        <ImageGroup
          key={g.key}
          group={g}
          selectedPath={selectedPath}
          onSelectImage={onSelectImage}
          // 528 UI entries make a poor first impression fully expanded, so start
          // closed and let the filter drive.
          defaultOpen={false}
          forceOpen={!!query}
        />
      ))}
      {cats && total > 0 && (
        <div className="side-note zone-count">
          {query ? `${shown} / ${total}` : `${total}`} images
        </div>
      )}
    </div>
  );
}

function ImageGroup({ group, selectedPath, onSelectImage, defaultOpen, forceOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  const show = forceOpen || open;

  return (
    <div className={`node${show ? ' open' : ''}`}>
      <div className="row" onClick={() => setOpen(!open)}>
        <span className="caret icon">chevron_right</span>
        <span className="kind icon">folder</span>
        <span>{group.label}</span>
        <span className="badge">{group.entries.length}</span>
      </div>
      {show && (
        <div className="children">
          {group.entries.map((e) => {
            const sel = selectedPath
              && selectedPath.toLowerCase().endsWith(e.path.toLowerCase());
            return (
              <div key={e.path + e.name} className={`node${sel ? ' selected' : ''}`}>
                <div className="row" onClick={() => onSelectImage?.(e)} title={e.path}>
                  <span className="caret icon" />
                  <span className="kind icon">image</span>
                  <span className="zone-name">{e.name}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
