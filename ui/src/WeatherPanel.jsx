import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/react';
import { Tooltip } from './Tooltip.jsx';

// FFXI weather ids → display names (only those present in a zone are listed).
const WEATHER_NAMES = {
  fine: 'Clear', suny: 'Sunshine', clod: 'Clouds', mist: 'Fog',
  dryw: 'Hot Spell', heat: 'Heat Wave', rain: 'Rain', squl: 'Squall',
  dust: 'Dust Storm', sand: 'Sand Storm', wind: 'Wind', stom: 'Gales',
  snow: 'Snow', bliz: 'Blizzards', thdr: 'Thunder', bolt: 'Thunderstorms',
  aura: 'Auroras', ligt: 'Stellar Glare', fogd: 'Gloom', dark: 'Darkness',
};
const weatherName = (id) => WEATHER_NAMES[id] ?? id;

const fmtTime = (min) => {
  const h = Math.floor(min / 60) % 24;
  const m = Math.floor(min % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

/**
 * Zone scene controls (top-right): weather/time when the zone has a skybox,
 * plus always-on background colour and lighting brightness (default → unlit).
 */
export function WeatherPanel({
  weathers = [], weather, timeMinutes, onChange,
  skyboxOn, onToggleSkybox, hasSkybox = false, objectsOpen,
  bgColor, onBg,
  brightness = 0, onBrightness,
}) {
  const showSkyControls = hasSkybox && weathers.length > 0;
  const brightPct = Math.round((brightness ?? 0) * 100);
  return (
    <div id="weather" className={`panel${objectsOpen ? ' with-objects' : ''}`}>
      <div className="wx-header">
        <span className="icon">landscape</span>
        <span className="wx-title">Zone Scene</span>
        {showSkyControls && <span className="wx-time mono">{fmtTime(timeMinutes)}</span>}
        {showSkyControls && (
          <Tooltip content="Show sky" placement="bottom">
            <label className="switch wx-switch">
              <input type="checkbox" checked={!!skyboxOn} onChange={(e) => onToggleSkybox(e.target.checked)} />
              <span className="track" />
            </label>
          </Tooltip>
        )}
      </div>

      <div className="wx-body">
        {showSkyControls ? (
          <div className={`wx-weather${skyboxOn ? '' : ' wx-off'}`}>
            <div className="wx-row">
              <Listbox value={weather} onChange={(w) => onChange(w, timeMinutes)}>
                <ListboxButton className="combo-input">
                  <span className="combo-value">{weatherName(weather)}</span>
                  <span className="icon combo-chevron">unfold_more</span>
                </ListboxButton>
                <ListboxOptions anchor="bottom start" className="combo-options">
                  {weathers.map((w) => (
                    <ListboxOption key={w} value={w} className="combo-option">{weatherName(w)}</ListboxOption>
                  ))}
                </ListboxOptions>
              </Listbox>
            </div>

            <div className="wx-row wx-time-row">
              <span className="icon wx-tod-icon">schedule</span>
              <input
                type="range" min="0" max="1439" step="15" value={timeMinutes}
                onChange={(e) => onChange(weather, +e.target.value)}
                className="vol-slider"
                style={{ '--fill': `${(timeMinutes / 1439) * 100}%` }}
              />
            </div>
          </div>
        ) : (
          <div className="wx-nosky">No Skybox for Indoor Zone</div>
        )}

        <div className="wx-row wx-bg-row">
          <span className="wx-bg-label">Scene Background Colour</span>
          <Tooltip content="Scene background colour" placement="left">
            <input
              type="color"
              className="wx-bg-swatch"
              value={bgColor || '#303438'}
              onChange={(e) => onBg?.(e.target.value)}
            />
          </Tooltip>
        </div>

        <div className="wx-row wx-bright-row">
          <Tooltip content="Brightness" placement="top">
            <span className="icon wx-tod-icon">light_mode</span>
          </Tooltip>
          <Tooltip content="Zone default → unlit" placement="top">
            <input
              type="range" min="0" max="100" step="1" value={brightPct}
              onChange={(e) => onBrightness?.(+e.target.value / 100)}
              className="vol-slider"
              style={{ '--fill': `${brightPct}%` }}
            />
          </Tooltip>
          <span className="wx-bright-val mono">{brightPct}%</span>
        </div>
      </div>
    </div>
  );
}
