import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Tooltip } from './Tooltip.jsx';

const MENUS = [
  {
    label: 'File',
    items: [
      { id: 'open-dat', label: 'Open DAT…', icon: 'file_open' },
      { id: 'export', label: 'Export', icon: 'download' },
      { id: 'settings', label: 'Settings', icon: 'settings' },
      { id: 'help', label: 'About', icon: 'star' },
    ],
  },
  {
    label: 'View',
    items: [
      { id: 'reset-camera', label: 'Reset Camera', icon: 'recenter' },
      { id: 'toggle-explorer', label: 'Toggle Explorer', icon: 'list_alt', check: 'explorer' },
      { id: 'toggle-wasd', label: 'Toggle WASD', icon: 'keyboard', check: 'wasd' },
      { id: 'toggle-wireframe', label: 'Toggle Wireframe', icon: 'grid_on', check: 'wireframe' },
      { id: 'toggle-textures', label: 'Toggle Textures', icon: 'texture', check: 'textures' },
      { id: 'toggle-alpha', label: 'Toggle Alpha', icon: 'opacity', check: 'alpha' },
      { id: 'toggle-unlit', label: 'Toggle Unlit', icon: 'light_mode', check: 'unlit' },
      { id: 'toggle-collision', label: 'Toggle Collision', icon: 'select_all', check: 'collision', disableWhen: 'noCollision' },
      { id: 'toggle-navmesh', label: 'Toggle Navmesh', icon: 'polyline', check: 'navmesh', disableWhen: 'noNavmesh' },
      { id: 'toggle-skybox', label: 'Toggle Skybox', icon: 'cloud', check: 'skybox', disableWhen: 'noSkybox' },
    ],
  },
  {
    label: 'Assets',
    items: [
      { id: 'assets-files', label: 'File Browser', icon: 'folder_open' },
      { id: 'assets-data', label: 'Data', icon: 'database', disabled: true },
      { id: 'assets-images', label: 'Images', icon: 'image', disabled: true },
      { id: 'assets-scene', label: 'Scene', icon: 'grass' },
      { id: 'assets-npcs', label: 'NPCs', icon: 'pets' },
      { id: 'assets-characters', label: 'Characters', icon: 'person' },
      { id: 'assets-effects', label: 'Effects', icon: 'auto_awesome', disabled: true },
      { id: 'assets-music', label: 'Music', icon: 'music_note' },
      { id: 'assets-sfx', label: 'Sound FX', icon: 'graphic_eq' },
      { id: 'assets-zones', label: 'Zones', icon: 'map' },
    ],
  },
];

/** Quick-toggle strip next to the menus — same View toggles, icon-only. */
const VIEW_TOOLBAR = MENUS.find((m) => m.label === 'View').items.filter((i) => i.check);

/**
 * Classic menubar: click opens; while open, hovering another top-level button
 * switches to it. The dropdown is portaled to <body> with fixed positioning so
 * it always layers above the blurred side panels (which form their own
 * stacking contexts and would otherwise swallow it).
 */
export function MenuBar({ onAction, checks = {} }) {
  const [active, setActive] = useState(null);   // { label, left, top } | null
  const barRef = useRef(null);
  const panelRef = useRef(null);

  useEffect(() => {
    if (!active) return;
    const close = (e) => {
      if (barRef.current?.contains(e.target)) return;
      if (panelRef.current?.contains(e.target)) return;
      setActive(null);
    };
    const onKey = (e) => e.key === 'Escape' && setActive(null);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [active]);

  const openMenu = (label, target) => {
    const rect = target.getBoundingClientRect();
    setActive({ label, left: rect.left, top: rect.bottom + 10 });
  };

  const activate = (id, label) => {
    setActive(null);
    onAction(id, label);
  };

  const activeMenu = active ? MENUS.find((m) => m.label === active.label) : null;

  return (
    <div id="menubar" className="panel" ref={barRef}>
      {MENUS.map((menu) => (
        <button
          key={menu.label}
          className={`menu-btn${active?.label === menu.label ? ' open' : ''}`}
          onClick={(e) => (active?.label === menu.label ? setActive(null) : openMenu(menu.label, e.currentTarget))}
          onMouseEnter={(e) => { if (active && active.label !== menu.label) openMenu(menu.label, e.currentTarget); }}
        >
          {menu.label}
        </button>
      ))}

      <span className="menu-sep" aria-hidden="true" />

      <div className="view-toolbar">
        {VIEW_TOOLBAR.map((item) => {
          const disabled = !!(item.disabled || (item.disableWhen && checks[item.disableWhen]));
          const on = !!(item.check && checks[item.check]);
          const tip = item.label.replace(/^Toggle\s+/i, '');
          return (
            <Tooltip key={item.id} content={tip} placement="bottom">
              <button
                type="button"
                className={`view-tool${on ? ' on' : ''}`}
                disabled={disabled}
                aria-label={tip}
                aria-pressed={on}
                onClick={() => !disabled && onAction(item.id, item.label)}
              >
                <span className="icon">{item.icon}</span>
              </button>
            </Tooltip>
          );
        })}
      </div>

      {activeMenu &&
        createPortal(
          <div
            className="menu-panel"
            ref={panelRef}
            style={{ position: 'fixed', left: active.left, top: active.top }}
          >
            {activeMenu.items.map((item) => {
              const disabled = !!(item.disabled || (item.disableWhen && checks[item.disableWhen]));
              return (
                <button
                  key={item.id}
                  className="menu-item"
                  disabled={disabled}
                  onClick={() => !disabled && activate(item.id, item.label)}
                >
                  <span className="icon">{item.icon}</span>
                  <span className="mi-label">{item.label}</span>
                  {item.check && checks[item.check] && <span className="icon mi-check">check</span>}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
