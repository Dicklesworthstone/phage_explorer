import React from 'react';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { useTheme } from '../../hooks/useTheme';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { useBeginnerMode } from '../../education';
import { useWebPreferences } from '../../store/createWebStore';
import { IconContrast, IconLearn, IconSettings } from '../ui';

export function SettingsOverlay(): React.ReactElement | null {
  const { close } = useOverlay();
  const { theme, setTheme, availableThemes } = useTheme();
  const reducedMotion = useReducedMotion();
  const highContrast = useWebPreferences((s) => s.highContrast);
  const setHighContrast = useWebPreferences((s) => s.setHighContrast);
  const backgroundEffects = useWebPreferences((s) => s.backgroundEffects);
  const setBackgroundEffects = useWebPreferences((s) => s.setBackgroundEffects);

  const {
    isEnabled: beginnerModeEnabled,
    enable: enableBeginnerMode,
    disable: disableBeginnerMode,
  } = useBeginnerMode();

  const handleToggleBeginner = () => {
    if (beginnerModeEnabled) {
      disableBeginnerMode();
    } else {
      enableBeginnerMode();
    }
  };

  return (
    <Overlay
      id="settings"
      title="Settings"
      icon={<IconSettings size={18} />}
      size="md"
      onClose={() => close('settings')}
    >
      <div className="settings-overlay">
        <section
          aria-label="Appearance settings"
          className="panel panel-compact settings-section"
        >
          <div className="settings-section-header">
            <IconContrast size={16} />
            <h3 className="settings-section-title">Appearance</h3>
          </div>

          <div className="settings-row">
            <div className="settings-row-text">
              <div className="settings-row-label">Theme</div>
              <div className="settings-row-desc">Choose the overall color palette.</div>
            </div>
            <select
              value={theme.id}
              onChange={(e) => setTheme(e.target.value)}
              aria-label="Select theme"
              className="input settings-select"
            >
              {availableThemes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>

          <div className="settings-row">
            <div className="settings-row-text">
              <div className="settings-row-label">High contrast</div>
              <div className="settings-row-desc">Increases text and border contrast for readability.</div>
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => setHighContrast(!highContrast)}
              aria-pressed={highContrast}
              aria-label={highContrast ? 'Disable high contrast mode' : 'Enable high contrast mode'}
            >
              {highContrast ? 'On' : 'Off'}
            </button>
          </div>

          <div className="settings-row">
            <div className="settings-row-text">
              <div className="settings-row-label">Background effects</div>
              <div className="settings-row-desc">
                Matrix rain and CRT overlay.
                {reducedMotion ? ' Disabled by your Reduced Motion preference.' : ''}
              </div>
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => setBackgroundEffects(!backgroundEffects)}
              aria-pressed={backgroundEffects}
              aria-label={backgroundEffects ? 'Disable background effects' : 'Enable background effects'}
              disabled={reducedMotion}
            >
              {backgroundEffects ? 'On' : 'Off'}
            </button>
          </div>
        </section>

        <section
          aria-label="Beginner mode setting"
          className="panel panel-compact settings-section"
        >
          <div className="settings-row settings-row--top">
            <div className="settings-row-text">
              <div className="settings-section-header">
                <IconLearn size={16} />
                <h3 className="settings-section-title">Beginner Mode</h3>
              </div>
              <p className="settings-paragraph">
                Shows glossary, context-aware help, guided tours, and learning overlays. Persists to localStorage so
                newcomers keep their learning setup between visits.
              </p>
              <p className="settings-meta">
                Current state: <strong>{beginnerModeEnabled ? 'Enabled' : 'Disabled'}</strong>
              </p>
            </div>
            <div className="settings-row-actions">
              <button
                type="button"
                className="btn"
                onClick={handleToggleBeginner}
                aria-pressed={beginnerModeEnabled}
                aria-label={beginnerModeEnabled ? 'Disable Beginner Mode' : 'Enable Beginner Mode'}
              >
                {beginnerModeEnabled ? 'Disable' : 'Enable'}
              </button>
            </div>
          </div>
        </section>

        <div className="settings-footer">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => close('settings')}
          >
            Close
          </button>
        </div>
      </div>
    </Overlay>
  );
}
