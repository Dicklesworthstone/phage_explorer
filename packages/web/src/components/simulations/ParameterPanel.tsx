/**
 * ParameterPanel - Simulation Parameter Editor
 *
 * Renders controls for editing simulation parameters.
 */

import React from 'react';
import { useTheme } from '../../hooks/useTheme';
import type { SimParameter } from '../../workers/types';

interface ParameterPanelProps {
  /** List of parameters */
  parameters: SimParameter[];
  /** Current parameter values */
  values: Record<string, number | boolean | string>;
  /** Callback when a parameter changes */
  onChange: (id: string, value: number | boolean | string) => void;
  /** Whether to disable all controls */
  disabled?: boolean;
  /** Compact layout */
  compact?: boolean;
}

export function ParameterPanel({
  parameters,
  values,
  onChange,
  disabled = false,
  compact = false,
}: ParameterPanelProps): React.ReactElement {
  const { theme } = useTheme();
  const colors = theme.colors;

  const renderControl = (param: SimParameter) => {
    const value = values[param.id] ?? param.defaultValue;

    if (param.type === 'boolean') {
      return (
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            cursor: disabled ? 'not-allowed' : 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(param.id, e.target.checked)}
            disabled={disabled}
            style={{
              width: '16px',
              height: '16px',
              accentColor: colors.primary,
            }}
          />
          <span style={{ color: colors.text, fontSize: compact ? '0.8rem' : '0.9rem' }}>
            {param.label}
          </span>
        </label>
      );
    }

    if (param.type === 'select' && param.options) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <label style={{ color: colors.textDim, fontSize: compact ? '0.7rem' : '0.75rem' }}>
            {param.label}
          </label>
          <select
            value={String(value)}
            onChange={(e) => onChange(param.id, e.target.value)}
            disabled={disabled}
            style={{
              padding: compact ? '0.3rem' : '0.4rem',
              border: `1px solid ${colors.borderLight}`,
              borderRadius: '4px',
              background: colors.backgroundAlt,
              color: colors.text,
              fontSize: compact ? '0.8rem' : '0.85rem',
              cursor: disabled ? 'not-allowed' : 'pointer',
            }}
          >
            {param.options.map((opt) => (
              <option key={String(opt.value)} value={String(opt.value)}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      );
    }

    // Number type (default)
    const numValue = Number(value);
    const min = param.min ?? 0;
    const max = param.max ?? 100;
    const step = param.step ?? 1;

    // Format large numbers
    const formatValue = (v: number): string => {
      if (Math.abs(v) >= 1e6) return v.toExponential(1);
      if (Math.abs(v) >= 1000) return v.toLocaleString();
      if (step < 1) return v.toFixed(2);
      return String(v);
    };

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <label style={{ color: colors.textDim, fontSize: compact ? '0.7rem' : '0.75rem' }}>
            {param.label}
          </label>
          <span
            style={{
              color: colors.primary,
              fontFamily: 'monospace',
              fontSize: compact ? '0.7rem' : '0.8rem',
            }}
          >
            {formatValue(numValue)}
          </span>
        </div>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={numValue}
          onChange={(e) => onChange(param.id, parseFloat(e.target.value))}
          disabled={disabled}
          style={{
            width: '100%',
            height: '4px',
            accentColor: colors.primary,
            cursor: disabled ? 'not-allowed' : 'pointer',
          }}
        />
      </div>
    );
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: compact ? '0.75rem' : '1rem',
        padding: compact ? '0.5rem' : '0.75rem',
        backgroundColor: colors.backgroundAlt,
        borderRadius: '4px',
        border: `1px solid ${colors.borderLight}`,
      }}
    >
      <div
        style={{
          fontSize: compact ? '0.75rem' : '0.85rem',
          fontWeight: 'bold',
          color: colors.primary,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}
      >
        Parameters
      </div>
      {parameters.map((param) => (
        <div key={param.id}>{renderControl(param)}</div>
      ))}
    </div>
  );
}

export default ParameterPanel;
