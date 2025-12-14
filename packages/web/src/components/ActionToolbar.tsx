/**
 * ActionToolbar Component
 *
 * A persistent toolbar that surfaces commonly-used controls that were previously
 * hidden behind keyboard shortcuts. Provides quick access to:
 * - View modes (DNA/AA/Dual)
 * - Reading frame selection
 * - Zoom controls
 * - Diff toggle
 * - 3D model toggle
 * - Analysis menu
 * - Settings
 */

import React from 'react';
import { usePhageStore } from '@phage-explorer/state';
import type { ViewMode } from '@phage-explorer/core';
import {
  IconDna,
  IconFlask,
  IconLayers,
  IconCube,
  IconSearch,
  IconSettings,
  IconChartBar,
  IconGitCompare,
  IconPlay,
  IconPause,
  IconZoomIn,
  IconZoomOut,
  IconHelp,
  IconCommand,
} from './ui';

interface ActionToolbarProps {
  onOpenSearch: () => void;
  onOpenAnalysis: () => void;
  onOpenComparison: () => void;
  onOpenSettings: () => void;
  onOpenHelp: () => void;
  onOpenCommandPalette: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  className?: string;
}

const VIEW_MODES: { id: ViewMode; label: string; icon: React.ReactNode; shortcut: string }[] = [
  { id: 'dna', label: 'DNA', icon: <IconDna size={16} />, shortcut: 'v' },
  { id: 'dual', label: 'Dual', icon: <IconLayers size={16} />, shortcut: 'v' },
  { id: 'aa', label: 'Amino Acids', icon: <IconFlask size={16} />, shortcut: 'v' },
];

const READING_FRAMES = [
  { value: 0, label: '+1' },
  { value: 1, label: '+2' },
  { value: 2, label: '+3' },
  { value: -1, label: '-1' },
  { value: -2, label: '-2' },
  { value: -3, label: '-3' },
];

export function ActionToolbar({
  onOpenSearch,
  onOpenAnalysis,
  onOpenComparison,
  onOpenSettings,
  onOpenHelp,
  onOpenCommandPalette,
  onZoomIn,
  onZoomOut,
  className = '',
}: ActionToolbarProps): React.ReactElement {
  const viewMode = usePhageStore((s) => s.viewMode);
  const setViewMode = usePhageStore((s) => s.setViewMode);
  const readingFrame = usePhageStore((s) => s.readingFrame);
  const setReadingFrame = usePhageStore((s) => s.setReadingFrame);
  const diffEnabled = usePhageStore((s) => s.diffEnabled);
  const toggleDiff = usePhageStore((s) => s.toggleDiff);
  const show3DModel = usePhageStore((s) => s.show3DModel);
  const toggle3DModel = usePhageStore((s) => s.toggle3DModel);
  const model3DPaused = usePhageStore((s) => s.model3DPaused);
  const toggle3DModelPause = usePhageStore((s) => s.toggle3DModelPause);
  const currentPhage = usePhageStore((s) => s.currentPhage);

  const hasPhage = currentPhage !== null;

  return (
    <div className={`action-toolbar ${className}`} role="toolbar" aria-label="Main actions">
      {/* View Mode Section */}
      <div className="toolbar-section">
        <span className="toolbar-label">View</span>
        <div className="toolbar-button-group" role="radiogroup" aria-label="Sequence view mode">
          {VIEW_MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              className={`toolbar-btn ${viewMode === mode.id ? 'active' : ''}`}
              onClick={() => setViewMode(mode.id)}
              disabled={!hasPhage}
              role="radio"
              aria-checked={viewMode === mode.id}
              title={`${mode.label} view (${mode.shortcut})`}
            >
              {mode.icon}
              <span className="toolbar-btn-label">{mode.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Reading Frame Section - Only show when AA or Dual mode */}
      {(viewMode === 'aa' || viewMode === 'dual') && (
        <div className="toolbar-section">
          <span className="toolbar-label">Frame</span>
          <select
            className="toolbar-select"
            value={readingFrame}
            onChange={(e) => setReadingFrame(Number(e.target.value) as 0 | 1 | 2 | -1 | -2 | -3)}
            disabled={!hasPhage}
            aria-label="Reading frame"
            title="Reading frame (f)"
          >
            {READING_FRAMES.map((frame) => (
              <option key={frame.value} value={frame.value}>
                {frame.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Zoom Section */}
      {onZoomIn && onZoomOut && (
        <div className="toolbar-section">
          <span className="toolbar-label">Zoom</span>
          <div className="toolbar-button-group">
            <button
              type="button"
              className="toolbar-btn"
              onClick={onZoomOut}
              disabled={!hasPhage}
              title="Zoom out (-)"
              aria-label="Zoom out"
            >
              <IconZoomOut size={16} />
            </button>
            <button
              type="button"
              className="toolbar-btn"
              onClick={onZoomIn}
              disabled={!hasPhage}
              title="Zoom in (+)"
              aria-label="Zoom in"
            >
              <IconZoomIn size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Divider */}
      <div className="toolbar-divider" aria-hidden="true" />

      {/* Toggle Section */}
      <div className="toolbar-section">
        <span className="toolbar-label">Display</span>
        <div className="toolbar-button-group">
          <button
            type="button"
            className={`toolbar-btn ${diffEnabled ? 'active' : ''}`}
            onClick={toggleDiff}
            disabled={!hasPhage}
            title="Toggle diff highlighting (d)"
            aria-pressed={diffEnabled}
          >
            <IconGitCompare size={16} />
            <span className="toolbar-btn-label">Diff</span>
          </button>
          <button
            type="button"
            className={`toolbar-btn ${show3DModel ? 'active' : ''}`}
            onClick={toggle3DModel}
            disabled={!hasPhage}
            title="Toggle 3D model (m)"
            aria-pressed={show3DModel}
          >
            <IconCube size={16} />
            <span className="toolbar-btn-label">3D</span>
          </button>
          {show3DModel && (
            <button
              type="button"
              className={`toolbar-btn toolbar-btn--small ${!model3DPaused ? 'active' : ''}`}
              onClick={toggle3DModelPause}
              title={model3DPaused ? 'Play animation (z)' : 'Pause animation (z)'}
              aria-label={model3DPaused ? 'Play 3D animation' : 'Pause 3D animation'}
            >
              {model3DPaused ? <IconPlay size={14} /> : <IconPause size={14} />}
            </button>
          )}
        </div>
      </div>

      {/* Divider */}
      <div className="toolbar-divider" aria-hidden="true" />

      {/* Actions Section */}
      <div className="toolbar-section">
        <span className="toolbar-label">Tools</span>
        <div className="toolbar-button-group">
          <button
            type="button"
            className="toolbar-btn toolbar-btn--primary"
            onClick={onOpenAnalysis}
            disabled={!hasPhage}
            title="Analysis tools (a)"
          >
            <IconChartBar size={16} />
            <span className="toolbar-btn-label">Analyze</span>
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onClick={onOpenComparison}
            disabled={!hasPhage}
            title="Compare genomes (c)"
          >
            <IconGitCompare size={16} />
            <span className="toolbar-btn-label">Compare</span>
          </button>
        </div>
      </div>

      {/* Spacer to push utility actions to the right */}
      <div className="toolbar-spacer" />

      {/* Utility Actions */}
      <div className="toolbar-section toolbar-section--compact">
        <button
          type="button"
          className="toolbar-btn toolbar-btn--icon"
          onClick={onOpenSearch}
          title="Search (s or /)"
          aria-label="Search"
        >
          <IconSearch size={18} />
        </button>
        <button
          type="button"
          className="toolbar-btn toolbar-btn--icon"
          onClick={onOpenCommandPalette}
          title="Command palette (:)"
          aria-label="Command palette"
        >
          <IconCommand size={18} />
        </button>
        <button
          type="button"
          className="toolbar-btn toolbar-btn--icon"
          onClick={onOpenHelp}
          title="Help & shortcuts (?)"
          aria-label="Help"
        >
          <IconHelp size={18} />
        </button>
        <button
          type="button"
          className="toolbar-btn toolbar-btn--icon"
          onClick={onOpenSettings}
          title="Settings (Ctrl+,)"
          aria-label="Settings"
        >
          <IconSettings size={18} />
        </button>
      </div>
    </div>
  );
}

export default ActionToolbar;
