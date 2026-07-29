import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Combobox, ComboboxButton, ComboboxInput, ComboboxOption, ComboboxOptions,
  Listbox, ListboxButton, ListboxOption, ListboxOptions,
} from '@headlessui/react';

// The one dropdown used across the app. Items are `{ id, label, group?, badge? }`.
//
// Short lists stay a plain Listbox: a button showing the value, with Headless
// UI's native-select typeahead (jump to the first entry whose label starts with
// what you typed). Long lists — gear runs to several hundred entries per slot —
// switch to a Combobox whose trigger is a filter field, because prefix-only
// typeahead inside a 350 ms window can't find "Melee Cyclas (MNK Relic)".
const SEARCH_MIN = 12;

/**
 * Native-select style arrow keys: while a combo's trigger is focused and its
 * panel is CLOSED, ArrowUp/ArrowDown steps the value directly (clamped, no
 * wrap) so gear/animation can be flipped through quickly. Headless UI returns
 * focus to the trigger after each pick, so cycling chains naturally.
 *
 * Must be attached with onKeyDownCapture: the trigger's own keydown opens the
 * panel and stops propagation, so a bubble-phase handler never runs.
 */
function cycleOnArrow(e, open, ids, value, onChange) {
  if (open || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
  if (ids.length === 0) return;
  e.preventDefault();
  e.stopPropagation();
  const dir = e.key === 'ArrowDown' ? 1 : -1;
  const next = ids[Math.min(Math.max(ids.indexOf(value) + dir, 0), ids.length - 1)];
  if (next !== undefined && next !== value) onChange(next);
}

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

/** Option rows for either flavour — `Option` is ListboxOption or ComboboxOption. */
function optionRows(items, Option) {
  return groupRows(items).map((r) =>
    r.header !== undefined
      ? <div key={r.key} className="combo-group">{r.header}</div>
      : (
        <Option key={r.key} value={r.item.id} className="combo-option">
          {r.item.label}
          {r.item.badge != null && <span className="opt-badge">{r.item.badge}</span>}
        </Option>
      ),
  );
}

/**
 * Floor for the portaled panel's width, as `[ref, style]`.
 *
 * The panel can't read the trigger's width off the cascade, and Headless UI's
 * own --button-width is measured from a requestAnimationFrame loop that reports
 * 0 until the first frame lands (and stays 0 while the window is occluded), so
 * the panel would flash up narrower than what it dropped out of. Measure the
 * trigger ourselves instead.
 */
function useTriggerWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.offsetWidth);
    const ro = new ResizeObserver(() => setWidth(el.offsetWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, { '--combo-min-width': `${width}px` }];
}

function PlainCombo({ value, items, onChange, placeholder, className }) {
  const current = items.find((i) => i.id === value);
  const [trigger, panelStyle] = useTriggerWidth();
  return (
    <Listbox value={value ?? ''} onChange={onChange}>
      {({ open }) => (
        <div
          style={{ display: 'contents' }}
          onKeyDownCapture={(e) => cycleOnArrow(e, open, items.map((i) => i.id), value, onChange)}
        >
          <ListboxButton ref={trigger} className={`combo-input${className ? ` ${className}` : ''}`}>
            <span className="combo-value">{current?.label ?? placeholder}</span>
            <span className="icon combo-chevron">unfold_more</span>
          </ListboxButton>
          <ListboxOptions anchor="bottom start" className="combo-options" style={panelStyle}>
            {optionRows(items, ListboxOption)}
          </ListboxOptions>
        </div>
      )}
    </Listbox>
  );
}

function SearchCombo({ value, items, onChange, placeholder, className }) {
  const [query, setQuery] = useState('');
  const [trigger, panelStyle] = useTriggerWidth();
  const label = items.find((i) => i.id === value)?.label ?? '';

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    // Every term has to land somewhere, so "relic cyclas" finds "Melee Cyclas
    // (MNK Relic)" however the words are ordered.
    const terms = q.split(/\s+/);
    return items.filter((it) => {
      const hay = `${it.label} ${it.group ?? ''}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [items, query]);

  return (
    <Combobox
      value={value ?? ''}
      // Headless UI reports an emptied field as a cleared selection; the slot
      // always holds something, so treat that as "still filtering" instead.
      onChange={(id) => { if (id != null) onChange(id); }}
      onClose={() => setQuery('')}
    >
      {({ open }) => (
        <div
          style={{ display: 'contents' }}
          onKeyDownCapture={(e) => cycleOnArrow(e, open, items.map((i) => i.id), value, onChange)}
        >
          {/* The trigger IS the button: an ordinary div around the field would
              sit outside Headless UI's dismiss allowlist (button/input/panel),
              so clicking its padding would read as a click-away and shut the
              panel with nothing to reopen it. As the button it also toggles on
              a second click, which focus alone can't do. */}
          <ComboboxButton as="div" ref={trigger} className={`combo-input${className ? ` ${className}` : ''}`}>
            <ComboboxInput
              className="combo-value combo-search"
              autoComplete="off"
              spellCheck="false"
              // Closed, the field reads as the value; open, it empties out so
              // typing starts a query rather than appending to a label, with
              // the pick demoted to placeholder so it stays legible. Headless
              // UI rewrites the field whenever this text changes, which is what
              // swaps the two — and it skips the rewrite mid-typing.
              displayValue={() => (open ? '' : label)}
              placeholder={open ? label : placeholder}
              // …but only on a *change*. The first pick is already in place by
              // the time the field mounts, so it needs seeding.
              defaultValue={label}
              onChange={(e) => setQuery(e.target.value)}
              // Keys are the field's business. Left to bubble, the enclosing
              // button would treat Space as "toggle" and swallow it, so a query
              // could never contain one.
              onKeyDown={(e) => e.stopPropagation()}
            />
            <span className="icon combo-chevron">unfold_more</span>
          </ComboboxButton>
          <ComboboxOptions anchor="bottom start" className="combo-options" style={panelStyle}>
            {shown.length === 0
              ? <div className="combo-empty">No match</div>
              : optionRows(shown, ComboboxOption)}
          </ComboboxOptions>
        </div>
      )}
    </Combobox>
  );
}

export function Combo({ value, items, onChange, placeholder = '—', className = '', searchable }) {
  const Impl = (searchable ?? items.length >= SEARCH_MIN) ? SearchCombo : PlainCombo;
  return (
    <Impl value={value} items={items} onChange={onChange}
          placeholder={placeholder} className={className} />
  );
}
