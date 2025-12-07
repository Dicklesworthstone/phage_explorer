/**
 * TimeControls - Unified Playback UI for Simulations
 *
 * Provides consistent play/pause, speed, and step controls
 * across all simulation types.
 */

import React from 'react';
import { useTheme } from '../../hooks/useTheme';
import type { SimulationControls } from '../../hooks/useSimulation';

interface TimeControlsProps {
  /** Simulation controls from useSimulation hook */
  controls: SimulationControls;
  /** Whether simulation is currently running */
  isRunning: boolean;
  /** Current simulation speed */
  speed: number;
  /** Current simulation time */
  time?: number;
  /** Whether controls should be disabled */
  disabled?: boolean;
  /** Compact mode for smaller displays */
  compact?: boolean;
  /** Additional info to display */
  statusText?: string;
}

const SPEED_OPTIONS = [0.25, 0.5, 1, 2, 4, 8];

export function TimeControls({
  controls,
  isRunning,
  speed,
  time = 0,
  disabled = false,
  compact = false,
  statusText,
}: TimeControlsProps): React.ReactElement {
  const { theme } = useTheme();
  const colors = theme.colors;

  const buttonStyle: React.CSSProperties = {
    padding: compact ? '0.3rem 0.5rem' : '0.5rem 0.75rem',
    border: `1px solid ${colors.borderLight}`,
    borderRadius: '4px',
    background: colors.backgroundAlt,
    color: colors.text,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    fontSize: compact ? '0.8rem' : '0.9rem',
    fontFamily: 'monospace',
    transition: 'all 0.15s ease',
  };

  const activeButtonStyle: React.CSSProperties = {
    ...buttonStyle,
    background: colors.primary,
    borderColor: colors.primary,
    color: colors.background,
  };

  const handleKeyDown = React.useCallback((e: React.KeyboardEvent) => {
    if (disabled) return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        controls.toggle();
        break;
      case '.':
        e.preventDefault();
        controls.step();
        break;
      case '+':
      case '=':
        e.preventDefault();
        controls.speedUp();
        break;
      case '-':
        e.preventDefault();
        controls.speedDown();
        break;
      case 'r':
      case 'R':
        e.preventDefault();
        controls.init();
        break;
    }
  }, [controls, disabled]);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: compact ? '0.5rem' : '1rem',
        padding: compact ? '0.5rem' : '0.75rem',
        backgroundColor: colors.background,
        borderRadius: '4px',
        border: `1px solid ${colors.borderLight}`,
      }}
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      {/* Play/Pause */}
      <button
        style={isRunning ? activeButtonStyle : buttonStyle}
        onClick={() => controls.toggle()}
        disabled={disabled}
        title={`${isRunning ? 'Pause' : 'Play'} (Space)`}
      >
        {isRunning ? '⏸' : '▶'}
      </button>

      {/* Step */}
      <button
        style={buttonStyle}
        onClick={() => controls.step()}
        disabled={disabled || isRunning}
        title="Step Forward (.)"
      >
        ⏭
      </button>

      {/* Reset */}
      <button
        style={buttonStyle}
        onClick={() => controls.init()}
        disabled={disabled}
        title="Reset (R)"
      >
        ⟲
      </button>

      {/* Divider */}
      <div style={{ width: '1px', height: '24px', backgroundColor: colors.borderLight }} />

      {/* Speed Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
        <button
          style={buttonStyle}
          onClick={() => controls.speedDown()}
          disabled={disabled || speed <= SPEED_OPTIONS[0]}
          title="Slow Down (-)"
        >
          ⏪
        </button>
        <span
          style={{
            minWidth: '3rem',
            textAlign: 'center',
            fontFamily: 'monospace',
            fontSize: compact ? '0.75rem' : '0.85rem',
            color: colors.textDim,
          }}
        >
          {speed}x
        </span>
        <button
          style={buttonStyle}
          onClick={() => controls.speedUp()}
          disabled={disabled || speed >= SPEED_OPTIONS[SPEED_OPTIONS.length - 1]}
          title="Speed Up (+)"
        >
          ⏩
        </button>
      </div>

      {/* Divider */}
      <div style={{ width: '1px', height: '24px', backgroundColor: colors.borderLight }} />

      {/* Time Display */}
      <div
        style={{
          fontFamily: 'monospace',
          fontSize: compact ? '0.75rem' : '0.85rem',
          color: colors.primary,
          minWidth: compact ? '4rem' : '5rem',
        }}
      >
        t={time.toFixed(0)}
      </div>

      {/* Status Text */}
      {statusText && (
        <>
          <div style={{ width: '1px', height: '24px', backgroundColor: colors.borderLight }} />
          <div
            style={{
              fontFamily: 'monospace',
              fontSize: compact ? '0.7rem' : '0.8rem',
              color: colors.textMuted,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: '200px',
            }}
          >
            {statusText}
          </div>
        </>
      )}

      {/* Keyboard hints */}
      {!compact && (
        <div
          style={{
            marginLeft: 'auto',
            fontSize: '0.7rem',
            color: colors.textMuted,
            display: 'flex',
            gap: '0.75rem',
          }}
        >
          <span><kbd style={{ padding: '0.1rem 0.3rem', background: colors.backgroundAlt, borderRadius: '2px' }}>Space</kbd> Play</span>
          <span><kbd style={{ padding: '0.1rem 0.3rem', background: colors.backgroundAlt, borderRadius: '2px' }}>.</kbd> Step</span>
          <span><kbd style={{ padding: '0.1rem 0.3rem', background: colors.backgroundAlt, borderRadius: '2px' }}>R</kbd> Reset</span>
        </div>
      )}
    </div>
  );
}

export default TimeControls;
