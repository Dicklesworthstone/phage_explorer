import React, { useEffect, useMemo } from 'react';
import { useTheme } from '../../hooks/useTheme';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { usePhageStore } from '../../store';

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function progressBar(fraction: number, color: string): React.ReactElement {
  const safeFraction = clamp01(fraction);
  return (
    <div
      style={{
        width: '100%',
        height: '10px',
        backgroundColor: 'rgba(255,255,255,0.08)',
        borderRadius: '4px',
        overflow: 'hidden',
        border: '1px solid rgba(255,255,255,0.1)',
      }}
    >
      <div
        style={{
          width: `${(safeFraction * 100).toFixed(1)}%`,
          height: '100%',
          background: color,
          transition: 'width 120ms ease-out',
        }}
      />
    </div>
  );
}

export function PackagingPressureOverlay(): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const phage = usePhageStore((s) => s.currentPhage);
  const scrollPosition = usePhageStore((s) => s.scrollPosition);
  const viewMode = usePhageStore((s) => s.viewMode);

  // Hotkey: V (matches TUI)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.key === 'v' || e.key === 'V') && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        toggle('pressure');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggle]);

  const metrics = useMemo(() => {
    const genomeLength = phage?.genomeLength ?? 0;
    if (!genomeLength) {
      return {
        fillFraction: 0,
        positionBp: 0,
        forcePn: 0,
        pressureAtm: 0,
        atpCount: 0,
      };
    }

    const scrollBp = viewMode === 'aa' ? scrollPosition * 3 : scrollPosition;
    const clampedBp = Math.max(0, Math.min(genomeLength, scrollBp));
    const fillFraction = clamp01(clampedBp / genomeLength);
    const forcePn = 5 + 50 * Math.pow(fillFraction, 3);
    const pressureAtm = Math.min(60, 5 + 55 * fillFraction);
    const atpCount = Math.floor(clampedBp / 2);

    return {
      fillFraction,
      positionBp: clampedBp,
      forcePn,
      pressureAtm,
      atpCount,
    };
  }, [phage?.genomeLength, scrollPosition, viewMode]);

  if (!isOpen('pressure')) {
    return null;
  }

  const fillPercent = (metrics.fillFraction * 100).toFixed(1);
  const pressureFraction = metrics.pressureAtm / 60;

  return (
    <Overlay
      id="pressure"
      title="PACKAGING PRESSURE"
      icon="🧲"
      hotkey="v"
      size="md"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div
          style={{
            padding: '0.75rem',
            backgroundColor: colors.backgroundAlt,
            borderRadius: '6px',
            color: colors.textDim,
            fontSize: '0.9rem',
            lineHeight: 1.4,
          }}
        >
          <strong style={{ color: colors.primary }}>Capsid filling model:</strong>{' '}
          force = 5 + 50·φ³ pN, pressure capped at 60 atm, ATP ≈ 1 per 2 bp.
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: '1rem',
          }}
        >
          <div style={{ padding: '0.75rem', backgroundColor: colors.backgroundAlt, borderRadius: '6px' }}>
            <div style={{ color: colors.textMuted, fontSize: '0.8rem' }}>Position</div>
            <div style={{ fontFamily: 'monospace', color: colors.text, fontSize: '1.1rem' }}>
              {metrics.positionBp.toLocaleString()} / {(phage?.genomeLength ?? 0).toLocaleString()} bp
            </div>
          </div>
          <div style={{ padding: '0.75rem', backgroundColor: colors.backgroundAlt, borderRadius: '6px' }}>
            <div style={{ color: colors.textMuted, fontSize: '0.8rem' }}>Fill</div>
            <div style={{ fontFamily: 'monospace', color: colors.text, fontSize: '1.1rem' }}>
              {fillPercent}%
            </div>
          </div>
          <div style={{ padding: '0.75rem', backgroundColor: colors.backgroundAlt, borderRadius: '6px' }}>
            <div style={{ color: colors.textMuted, fontSize: '0.8rem' }}>Force</div>
            <div style={{ fontFamily: 'monospace', color: colors.text, fontSize: '1.1rem' }}>
              {metrics.forcePn.toFixed(1)} pN
            </div>
          </div>
          <div style={{ padding: '0.75rem', backgroundColor: colors.backgroundAlt, borderRadius: '6px' }}>
            <div style={{ color: colors.textMuted, fontSize: '0.8rem' }}>Pressure</div>
            <div style={{ fontFamily: 'monospace', color: pressureFraction > 0.8 ? colors.error : colors.text, fontSize: '1.1rem' }}>
              {metrics.pressureAtm.toFixed(1)} atm
            </div>
          </div>
          <div style={{ padding: '0.75rem', backgroundColor: colors.backgroundAlt, borderRadius: '6px' }}>
            <div style={{ color: colors.textMuted, fontSize: '0.8rem' }}>ATP consumed</div>
            <div style={{ fontFamily: 'monospace', color: colors.text, fontSize: '1.1rem' }}>
              {metrics.atpCount.toLocaleString()}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div>
            <div style={{ color: colors.textMuted, marginBottom: '0.25rem', fontSize: '0.85rem' }}>
              Fill fraction
            </div>
            {progressBar(metrics.fillFraction, colors.success)}
          </div>
          <div>
            <div style={{ color: colors.textMuted, marginBottom: '0.25rem', fontSize: '0.85rem' }}>
              Pressure (warn above 50 atm)
            </div>
            {progressBar(pressureFraction, pressureFraction > 0.83 ? colors.error : colors.accent)}
          </div>
        </div>

        {!phage && (
          <div
            style={{
              textAlign: 'center',
              padding: '1rem',
              color: colors.textMuted,
              border: `1px dashed ${colors.borderLight}`,
              borderRadius: '6px',
            }}
          >
            Load a phage genome to visualize packaging pressure along the sequence.
          </div>
        )}
      </div>
    </Overlay>
  );
}

export default PackagingPressureOverlay;

